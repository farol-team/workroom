require "test_helper"

# One turn, through the whole stack, the way the client drives it.
#
# Every part below is covered in isolation elsewhere. Nothing covered them
# together, so a regression in a seam passed CI. A turn that persists correctly
# and tells nobody is the failure this product cannot afford, so the broadcasts
# are asserted, not only the rows.
class FullTurnTest < ActionDispatch::IntegrationTest
  setup do
    @alice = user(name: "Alice")
    @bob = user(name: "Bob")
    @channel = channel(name: "Meetings")
    [ @alice, @bob ].each { |u| @channel.memberships.create!(user: u) }

    Memory::Store.current.write(@channel,
      title: "Acme reporting cadence",
      detail: "Monthly rollups, first Tuesday. Weekly created noise nobody read.",
      trust: "human", author: @alice, key: "acme-cadence")

    # The turn below finds something the room *already knew*, and that word is
    # doing work: a store that computes its index makes "written" and "findable"
    # different moments. A store that does not returns on the first attempt.
    # The turn below finds something the room *already knew*, and that word is
    # doing work. A store that computes its index makes "written" and "findable"
    # different moments, and how different depends on what else it is indexing —
    # seconds when idle, longer behind a burst of writes. A store that does not
    # compute returns on the first attempt.
    90.times do
      break if Memory::Store.current.search(@channel, "Acme reporting cadence").present?
      sleep 1
    end

    @json = { "Content-Type" => "application/json" }
  end

  def as(user) = auth(user).merge(@json)

  def rpc(method, params = {}, user: @alice)
    post api_v1_rail_path(@channel.slug),
         params: { jsonrpc: "2.0", id: 1, method: method, params: params }.to_json,
         headers: as(user)
    response.parsed_body
  end

  test "a complete turn: asked, planned, worked, answered, remembered, attached" do
    room = []
    stream = Broadcast.stream_for(@channel)
    original = ActionCable.server.method(:broadcast)
    ActionCable.server.define_singleton_method(:broadcast) do |target, payload|
      room << payload if target == stream
      original.call(target, payload)
    end

    # --- what the room already knows, as it reaches an agent session ---
    get api_v1_channel_context_path(@channel.slug), headers: as(@alice)
    assert_response :success
    context = response.parsed_body["context"]
    assert_includes context, "Acme reporting cadence"
    assert_includes context, "•", "a person's assertion is marked as one"

    # --- a person asks ---
    post api_v1_channel_messages_path(@channel.slug),
         params: { body: "@agent what did we agree with Acme?" }.to_json, headers: as(@alice)
    assert_response :created
    question_id = response.parsed_body["id"]

    # --- the client opens a run ---
    post api_v1_channel_runs_path(@channel.slug),
         params: { trigger_message_id: question_id, external_id: "ses_e2e",
                   model: "opencode/big-pickle" }.to_json,
         headers: as(@alice)
    assert_response :created
    run_id = response.parsed_body["id"]

    # --- the agent states its plan ---
    post api_v1_run_plan_path(run_id),
         params: { entries: [ { content: "Search what the room knows", status: "in_progress" },
                              { content: "Answer from it", status: "pending" } ] }.to_json,
         headers: as(@alice)
    assert_response :success

    # --- the agent reaches memory through the rail ---
    # With the question it was asked, which is what an agent actually sends.
    found = JSON.parse(rpc("tools/call",
      { name: "search_capabilities", arguments: { query: "what did we agree with Acme about reporting?" } })
      .dig("result", "content", 0, "text"))
    assert_equal [ "Acme reporting cadence" ], found.select { |c| c["kind"] == "knowledge" }.map { |c| c["title"] }

    detail = rpc("tools/call",
      { name: "execute_capability", arguments: { uri: found.first["uri"] } })
      .dig("result", "content", 0, "text")
    assert_includes detail, "first Tuesday"

    # --- work happens ---
    post api_v1_run_steps_path(run_id),
         params: { kind: "tool_use", label: "memory.search: Acme" }.to_json, headers: as(@alice)
    assert_response :success

    # --- the agent answers ---
    post api_v1_run_messages_path(run_id),
         params: { body: "Monthly rollups, first Tuesday." }.to_json, headers: as(@alice)
    assert_response :created

    # --- and records what it learned, itself (Article P3) ---
    rpc("tools/call", { name: "execute_capability", arguments: {
      uri: "workroom://memory/remember",
      args: { title: "Acme prefers a monthly rhythm",
              detail: "Confirmed in conversation; weekly was noise." } } })

    # --- usage and close ---
    patch api_v1_run_path(run_id),
          params: { status: "succeeded", context_used: 84_000, context_size: 200_000,
                    cost: "0.12" }.to_json,
          headers: as(@alice)
    assert_response :success

    # --- the transcript is attached deliberately ---
    post api_v1_run_artifacts_path(run_id),
         params: { name: "run-#{run_id} transcript.json", kind: "transcript",
                   content: { info: { id: "ses_e2e" }, messages: [] }.to_json }.to_json,
         headers: as(@alice)
    assert_response :created

    # === what the room saw ===
    kinds = room.map { |p| p[:type] }
    assert_includes kinds, "message"
    assert_includes kinds, "run"
    assert_includes kinds, "plan"
    assert_includes kinds, "artifact"
    refute_includes kinds, "step", "process is recorded, never pushed at the room"

    # === what is left behind ===
    run = AgentRun.find(run_id)
    assert_equal "succeeded", run.status
    assert_equal "opencode/big-pickle", run.model
    assert_in_delta 0.42, run.context_fraction, 0.001
    assert_equal 0.12, run.cost.to_f
    assert_equal 1, run.run_steps.where(kind: "plan").count
    assert_equal 1, run.artifacts.count

    answer = @channel.messages.order(:created_at).last
    assert answer.from_agent?
    assert_equal question_id, answer.parent_id

    # === and what the next person's agent will read ===
    get api_v1_channel_context_path(@channel.slug), headers: as(@bob)
    assert_response :success
    rehydrated = response.parsed_body["context"]
    assert_includes rehydrated, "Acme prefers a monthly rhythm",
                    "what one agent learned is what the next one starts from"
    assert_includes rehydrated, "◦", "an agent's inference is marked as one"
  ensure
    ActionCable.server.singleton_class.send(:remove_method, :broadcast)
  end

  test "a colleague's agent starts from the room, not from nothing" do
    Memory::Store.current.write(@channel, title: "Decision", detail: "Ship on Friday.",
                                trust: "human", author: @alice, key: "ship")

    get api_v1_channel_context_path(@channel.slug), headers: as(@bob)

    assert_response :success
    assert_includes response.parsed_body["context"], "Ship on Friday."
  end

  test "a stranger reaches none of it" do
    stranger = user(name: "Stranger")
    @channel.update!(visibility: "private")

    get api_v1_channel_context_path(@channel.slug), headers: as(stranger)
    assert_response :forbidden

    post api_v1_rail_path(@channel.slug),
         params: { jsonrpc: "2.0", id: 1, method: "tools/list" }.to_json, headers: as(stranger)
    assert_response :forbidden
  end
end
