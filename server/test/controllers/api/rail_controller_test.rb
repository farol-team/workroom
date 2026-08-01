require "test_helper"

# The rail is one MCP endpoint with exactly two tools. Fifty skills as fifty
# tools would charge every session for fifty schemas before anything happened.
class Api::V1::RailControllerTest < ActionDispatch::IntegrationTest
  setup do
    @channel = channel(name: "Meetings")
    @alice = user(name: "Alice")
    @store = Memory::Store.current
    @store.write(@channel, title: "Acme reporting cadence",
                 detail: "Monthly rollups, first Tuesday.", trust: "human", author: @alice)
    @json = { "Content-Type" => "application/json" }
  end

  def rpc(method, params = {}, user: @alice, slug: @channel.slug)
    post api_v1_rail_path(slug),
         params: { jsonrpc: "2.0", id: 1, method: method, params: params }.to_json,
         headers: (user ? auth(user) : {}).merge(@json)
    response.parsed_body
  end

  test "the handshake reports the protocol and the server" do
    body = rpc("initialize", { protocolVersion: "2025-06-18" })

    assert_response :success
    assert_equal "2.0", body["jsonrpc"]
    assert body.dig("result", "protocolVersion").present?
    assert_equal "workroom-rail", body.dig("result", "serverInfo", "name")
  end

  test "it offers two tools and no more, however many capabilities exist" do
    5.times { |i| @store.write(@channel, title: "Entry #{i}", detail: "d", key: "e#{i}") }

    tools = rpc("tools/list").dig("result", "tools")

    assert_equal %w[execute_capability search_capabilities], tools.map { |t| t["name"] }.sort
  end

  test "search finds what the room knows" do
    out = rpc("tools/call", { name: "search_capabilities", arguments: { query: "reporting" } })
    found = JSON.parse(out.dig("result", "content", 0, "text"))

    assert_equal 1, found.length
    assert_equal "Acme reporting cadence", found.first["title"]
    assert found.first["uri"].start_with?("viking://resources/channels/#{@channel.slug}/")
    refute found.first.key?("detail"), "discovery returns the abstract, not the whole entry"
  end

  test "search offers the actions an agent may take, not only what it may read" do
    found = JSON.parse(rpc("tools/call",
      { name: "search_capabilities", arguments: { query: "remember" } })
      .dig("result", "content", 0, "text"))

    assert_includes found.map { |c| c["uri"] }, "workroom://memory/remember"
  end

  test "what an agent chose to keep is attributed to the run that kept it" do
    # A run that kept nothing and a run whose memory nobody can trace back look
    # the same from the outside, and only one of them is fine.
    message = @channel.messages.create!(author: @alice, body: "@agent what did we agree?")
    run = agent_run(user: @alice, channel: @channel, trigger: message)

    rpc("tools/call", { name: "execute_capability", arguments: {
      uri: "workroom://memory/remember",
      args: { title: "Monthly rollups", detail: "First Tuesday, agreed with Acme." } } })

    assert run.reload.distilled_at, "the run that produced the entry is the run that records it"
  end

  test "a run that kept nothing says so by staying unmarked" do
    message = @channel.messages.create!(author: @alice, body: "@agent what did we agree?")
    run = agent_run(user: @alice, channel: @channel, trigger: message)

    rpc("tools/call", { name: "search_capabilities", arguments: { query: "anything" } })

    assert_nil run.reload.distilled_at, "silence is an outcome, not a missing record"
  end

  test "a procedure and a fact are not offered as the same kind of thing" do
    # An agent that cannot tell them apart cites a convention as evidence, or
    # follows a stale fact as if it were the way things are done.
    Memory::Store.current.write_skill(@channel, title: "Running a client call",
      body: "Agenda out the day before. Recap decisions before it ends.")

    found = JSON.parse(rpc("tools/call",
      { name: "search_capabilities", arguments: { query: "running a client call" } })
      .dig("result", "content", 0, "text"))

    skill = found.find { |c| c["title"] == "Running a client call" }
    refute_nil skill, "a skill is discovered through the same rail as everything else"
    assert_equal "skill", skill["kind"], "a procedure is not knowledge"
  end

  test "a skill is read in full through the rail, like anything else" do
    skill = Memory::Store.current.write_skill(@channel, title: "Running a client call",
      body: "Agenda out the day before. Recap decisions before it ends.")

    text = rpc("tools/call", { name: "execute_capability", arguments: { uri: skill.uri } })
           .dig("result", "content", 0, "text")

    assert_includes text, "Recap decisions"
  end

  test "an agent asking in a sentence still finds the action it needs" do
    found = JSON.parse(rpc("tools/call",
      { name: "search_capabilities", arguments: { query: "I should remember this conclusion" } })
      .dig("result", "content", 0, "text"))

    assert_includes found.map { |c| c["uri"] }, "workroom://memory/remember",
      "the rail is discovered in the agent's own words, not by exact phrase"
  end

  test "executing a knowledge capability returns the detail tier" do
    uri = MemoryEntry.last.uri
    out = rpc("tools/call", { name: "execute_capability", arguments: { uri: uri } })

    assert_includes out.dig("result", "content", 0, "text"), "Monthly rollups"
  end

  # Article P3 as amended: the agent writes. No approval, no queue.
  test "an agent records what it learned" do
    assert_difference -> { MemoryEntry.count }, 1 do
      rpc("tools/call", { name: "execute_capability", arguments: {
        uri: "workroom://memory/remember",
        args: { title: "Pricing objection", detail: "Setup cost, not price." } } })
    end

    entry = MemoryEntry.current.find_by(title: "Pricing objection")
    assert_equal "agent", entry.trust
    assert_equal @channel, entry.channel
  end

  # The obligation that replaced the human gate.
  test "an agent resolves a contradiction by superseding" do
    stale = MemoryEntry.last

    rpc("tools/call", { name: "execute_capability", arguments: {
      uri: "workroom://memory/supersede",
      args: { uri: stale.uri, reason: "contradicted by a later call" } } })

    assert stale.reload.superseded_at
  end

  # Reading another room is already refused. Unwriting one was not, and it is
  # the worse of the two: the entry is gone from the room that relied on it and
  # nobody in that room did anything (Article P5).
  test "an agent cannot supersede what another room knows" do
    other = channel(name: "Marketing")
    theirs = @store.write(other, title: "Campaign brief", detail: "Elsewhere.")

    out = rpc("tools/call", { name: "execute_capability", arguments: {
      uri: "workroom://memory/supersede",
      args: { uri: theirs.uri, reason: "not mine to correct" } } })

    assert out.dig("result", "isError"), "a uri outside this channel is no capability of this rail"
    assert_nil theirs.reload.superseded_at, "nothing was moved (Article P5)"
  end

  test "a rail url cannot reach another room" do
    other = channel(name: "Marketing")
    @store.write(other, title: "Campaign brief", detail: "Elsewhere.")

    found = JSON.parse(rpc("tools/call",
      { name: "search_capabilities", arguments: { query: "Campaign" } })
      .dig("result", "content", 0, "text"))

    assert_empty found, "the channel in the url is the scope (Article P5)"
  end

  test "an unauthenticated call is refused" do
    rpc("tools/list", {}, user: nil)
    assert_response :unauthorized
  end

  test "a non-member of a private channel is refused" do
    @channel.update!(visibility: "private")
    rpc("tools/list", {}, user: user(name: "Bob"))
    assert_response :forbidden
  end

  test "an unknown method answers with an error, not a crash" do
    body = rpc("tools/nonsense")

    assert_response :success
    assert_equal(-32_601, body.dig("error", "code"))
  end

  test "an unknown capability answers with an error" do
    out = rpc("tools/call", { name: "execute_capability", arguments: { uri: "viking://nope" } })

    assert out.dig("result", "isError"), "a bad uri is a tool error, not a protocol error"
  end
end
