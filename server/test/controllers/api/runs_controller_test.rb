require "test_helper"

class Api::RunsControllerTest < ActionDispatch::IntegrationTest
  setup do
    @channel = channel
    @alice = user(name: "Alice")
    @json = { "Content-Type" => "application/json" }
  end

  test "a full turn records the run, its steps, and an answer attributed to the run" do
    message = @channel.messages.create!(author: @alice, body: "what did we agree?")

    post api_channel_runs_path(@channel.slug),
         params: { trigger_message_id: message.id, external_id: "ses_x" }.to_json,
         headers: auth(@alice).merge(@json)
    assert_response :created
    run_id = response.parsed_body["id"]

    post api_run_steps_path(run_id),
         params: { kind: "tool_use", label: "memory.search" }.to_json,
         headers: auth(@alice).merge(@json)
    assert_response :success

    post api_run_messages_path(run_id),
         params: { body: "monthly, first Tuesday" }.to_json,
         headers: auth(@alice).merge(@json)
    assert_response :created

    patch api_run_path(run_id),
          params: { status: "succeeded", context_used: 100, context_size: 200 }.to_json,
          headers: auth(@alice).merge(@json)
    assert_response :success

    run = AgentRun.find(run_id)
    assert_equal 1, run.run_steps.count
    assert_equal "succeeded", run.status
    assert run.ended_at, "a finished run must record when it ended"
    assert_in_delta 0.5, run.context_fraction, 0.001
    assert_equal "idle", run.agent_session.reload.status

    answer = @channel.messages.last
    assert answer.from_agent?
    assert_equal run, answer.author
    assert_equal message.id, answer.parent_id, "the answer belongs to the thread that asked"
  end

  test "a plan is recorded against the run and revisions append" do
    post api_channel_runs_path(@channel.slug), params: {}.to_json, headers: auth(@alice).merge(@json)
    run_id = response.parsed_body["id"]

    2.times do |i|
      post api_run_plan_path(run_id),
           params: { entries: [ { content: "Step #{i}", status: "pending" } ] }.to_json,
           headers: auth(@alice).merge(@json)
      assert_response :success
    end

    steps = AgentRun.find(run_id).run_steps.where(kind: "plan").order(:created_at)
    assert_equal 2, steps.count, "a revision appends; it never overwrites (Article P6)"
    assert_equal "Step 1", steps.last.payload.dig("entries", 0, "content")
  end

  test "someone else's run will not take a plan" do
    post api_channel_runs_path(@channel.slug), params: {}.to_json, headers: auth(@alice).merge(@json)
    run_id = response.parsed_body["id"]

    post api_run_plan_path(run_id), params: { entries: [] }.to_json,
         headers: auth(user(name: "Bob")).merge(@json)

    assert_response :not_found
  end

  test "a run remembers which model produced it" do
    post api_channel_runs_path(@channel.slug),
         params: { model: "opencode/mimo-v2.5-free" }.to_json,
         headers: auth(@alice).merge(@json)

    assert_response :created
    assert_equal "opencode/mimo-v2.5-free", AgentRun.find(response.parsed_body["id"]).model,
                 "memory distilled from a run inherits what produced it (Article P4)"
  end

  test "one session is reused for the same person in the same channel" do
    2.times do
      post api_channel_runs_path(@channel.slug), params: {}.to_json,
           headers: auth(@alice).merge(@json)
    end

    assert_equal 1, AgentSession.where(user: @alice, channel: @channel).count
  end

  test "a run belonging to someone else is not reachable" do
    bob = user(name: "Bob")
    post api_channel_runs_path(@channel.slug), params: {}.to_json, headers: auth(bob).merge(@json)
    bobs_run = response.parsed_body["id"]

    patch api_run_path(bobs_run), params: { status: "failed" }.to_json,
          headers: auth(@alice).merge(@json)

    assert_response :not_found
  end
end
