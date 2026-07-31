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
          params: { status: "succeeded", input_tokens: 100, output_tokens: 20 }.to_json,
          headers: auth(@alice).merge(@json)
    assert_response :success

    run = AgentRun.find(run_id)
    assert_equal 1, run.run_steps.count
    assert_equal "succeeded", run.status
    assert run.ended_at, "a finished run must record when it ended"
    assert_equal 120, run.total_tokens
    assert_equal "idle", run.agent_session.reload.status

    answer = @channel.messages.last
    assert answer.from_agent?
    assert_equal run, answer.author
    assert_equal message.id, answer.parent_id, "the answer belongs to the thread that asked"
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
