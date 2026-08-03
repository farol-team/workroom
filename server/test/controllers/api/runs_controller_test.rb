require "test_helper"

class Api::V1::RunsControllerTest < ActionDispatch::IntegrationTest
  setup do
    @channel = channel
    @alice = user(name: "Alice")
    @json = { "Content-Type" => "application/json" }
  end

  test "two agents in one channel keep two sessions" do
    # A session id belongs to the process that issued it. Reused across agents,
    # the second agent inherits an id its process has never heard of — and the
    # transcript exported afterwards is somebody else's.
    m1 = @channel.messages.create!(author: @alice, body: "first")
    m2 = @channel.messages.create!(author: @alice, body: "second")

    post api_v1_channel_runs_path(@channel.slug),
         params: { trigger_message_id: m1.id, agent_kind: "opencode", external_id: "ses_open" }.to_json,
         headers: auth(@alice).merge(@json)
    assert_response :created

    post api_v1_channel_runs_path(@channel.slug),
         params: { trigger_message_id: m2.id, agent_kind: "claude", external_id: "ses_claude" }.to_json,
         headers: auth(@alice).merge(@json)
    assert_response :created

    sessions = AgentSession.where(user: @alice, channel: @channel)
    assert_equal 2, sessions.count, "one session per agent, not one per channel"
    assert_equal %w[ses_claude ses_open], sessions.pluck(:external_id).sort
    assert_equal %w[claude opencode], sessions.pluck(:agent_kind).sort
  end

  test "the same agent asked twice keeps one session" do
    m1 = @channel.messages.create!(author: @alice, body: "first")
    m2 = @channel.messages.create!(author: @alice, body: "second")

    2.times do |i|
      post api_v1_channel_runs_path(@channel.slug),
           params: { trigger_message_id: [ m1, m2 ][i].id, agent_kind: "opencode",
                     external_id: "ses_open" }.to_json,
           headers: auth(@alice).merge(@json)
      assert_response :created
    end

    assert_equal 1, AgentSession.where(user: @alice, channel: @channel).count
    assert_equal 2, AgentSession.last.agent_runs.count, "both turns belong to the one session"
  end

  test "a run keeps every metric the agent gives, and invents none" do
    # Reporting, never billing (#97). The currency travels as the agent said it;
    # a field the agent never reported stays nil rather than becoming a zero.
    message = @channel.messages.create!(author: @alice, body: "how much?")
    post api_v1_channel_runs_path(@channel.slug),
         params: { trigger_message_id: message.id, external_id: "ses_1" }.to_json,
         headers: auth(@alice).merge(@json)
    run_id = response.parsed_body["id"]

    patch api_v1_run_path(run_id),
          params: { status: "running", context_used: 84_000, context_size: 200_000,
                    cost: 0.42, cost_currency: "EUR" }.to_json,
          headers: auth(@alice).merge(@json)
    patch api_v1_run_path(run_id),
          params: { status: "succeeded", stop_reason: "max_tokens",
                    total_tokens: 1200, input_tokens: 1000, output_tokens: 200,
                    cached_read_tokens: 800,
                    metrics: { "_claude/origin" => "subscription" } }.to_json,
          headers: auth(@alice).merge(@json)

    run = AgentRun.find(run_id)
    assert_equal "EUR", run.cost_currency
    assert_equal "max_tokens", run.stop_reason, "a turn that ran out is not one that finished"
    assert_equal [ 1200, 1000, 200, 800 ],
                 run.slice(:total_tokens, :input_tokens, :output_tokens, :cached_read_tokens).values
    assert_nil run.thought_tokens, "unreported stays unknown, never zero"
    assert_equal({ "_claude/origin" => "subscription" }, run.metrics)
  end

  test "a full turn records the run, its steps, and an answer attributed to the run" do
    message = @channel.messages.create!(author: @alice, body: "what did we agree?")

    post api_v1_channel_runs_path(@channel.slug),
         params: { trigger_message_id: message.id, external_id: "ses_x" }.to_json,
         headers: auth(@alice).merge(@json)
    assert_response :created
    run_id = response.parsed_body["id"]

    post api_v1_run_steps_path(run_id),
         params: { kind: "tool_use", label: "memory.search" }.to_json,
         headers: auth(@alice).merge(@json)
    assert_response :success

    post api_v1_run_messages_path(run_id),
         params: { body: "monthly, first Tuesday" }.to_json,
         headers: auth(@alice).merge(@json)
    assert_response :created

    patch api_v1_run_path(run_id),
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
    post api_v1_channel_runs_path(@channel.slug), params: {}.to_json, headers: auth(@alice).merge(@json)
    run_id = response.parsed_body["id"]

    2.times do |i|
      post api_v1_run_plan_path(run_id),
           params: { entries: [ { content: "Step #{i}", status: "pending" } ] }.to_json,
           headers: auth(@alice).merge(@json)
      assert_response :success
    end

    steps = AgentRun.find(run_id).run_steps.where(kind: "plan").order(:created_at)
    assert_equal 2, steps.count, "a revision appends; it never overwrites (Article P6)"
    assert_equal "Step 1", steps.last.payload.dig("entries", 0, "content")
  end

  test "someone else's run will not take a plan" do
    post api_v1_channel_runs_path(@channel.slug), params: {}.to_json, headers: auth(@alice).merge(@json)
    run_id = response.parsed_body["id"]

    post api_v1_run_plan_path(run_id), params: { entries: [] }.to_json,
         headers: auth(user(name: "Bob")).merge(@json)

    assert_response :not_found
  end

  test "a run remembers which model produced it" do
    post api_v1_channel_runs_path(@channel.slug),
         params: { model: "opencode/mimo-v2.5-free" }.to_json,
         headers: auth(@alice).merge(@json)

    assert_response :created
    assert_equal "opencode/mimo-v2.5-free", AgentRun.find(response.parsed_body["id"]).model,
                 "memory distilled from a run inherits what produced it (Article P4)"
  end

  test "one session is reused for the same person in the same channel" do
    2.times do
      post api_v1_channel_runs_path(@channel.slug), params: {}.to_json,
           headers: auth(@alice).merge(@json)
    end

    assert_equal 1, AgentSession.where(user: @alice, channel: @channel).count
  end

  test "a run belonging to someone else is not reachable" do
    bob = user(name: "Bob")
    post api_v1_channel_runs_path(@channel.slug), params: {}.to_json, headers: auth(bob).merge(@json)
    bobs_run = response.parsed_body["id"]

    patch api_v1_run_path(bobs_run), params: { status: "failed" }.to_json,
          headers: auth(@alice).merge(@json)

    assert_response :not_found
  end
end
