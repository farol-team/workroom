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

  def journal = @channel.channel_records.order(:seq)

  def payload_of(entry) = JSON.parse(RecordStore::Objects.current.get(entry.entry_hash))["payload"]

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

  test "a channel with a repository is told how to publish into it" do
    # Promotion is a step, not an effect (#208): the rail says how, and the
    # how names where. The url is the room's own setting (#203).
    @channel.update!(repository_url: "https://github.com/acme/widgets")

    found = JSON.parse(rpc("tools/call",
      { name: "search_capabilities", arguments: { query: "publish the decision to the repository" } })
      .dig("result", "content", 0, "text"))
    assert_includes found.map { |c| c["uri"] }, "workroom://channel/publish"

    text = rpc("tools/call", { name: "execute_capability",
      arguments: { uri: "workroom://channel/publish" } })
      .dig("result", "content", 0, "text")
    assert_includes text, "https://github.com/acme/widgets"
    assert_includes text, "agent/", "the branch discipline is #205's, and the text carries it"
    assert_includes text, "human", "a human merges, never the agent unasked"
  end

  test "a channel without a repository has nothing to publish into" do
    found = JSON.parse(rpc("tools/call",
      { name: "search_capabilities", arguments: { query: "publish the decision to the repository" } })
      .dig("result", "content", 0, "text"))
    refute_includes found.map { |c| c["uri"] }, "workroom://channel/publish"

    out = rpc("tools/call", { name: "execute_capability",
      arguments: { uri: "workroom://channel/publish" } })
    assert out.dig("result", "isError"), "an instruction for a room without a clone is a capability it does not have"
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

  test "what an agent kept says whose agent kept it" do
    # The rail is reached by an agent holding its owner's token. An entry that
    # arrives marked "agent" and nothing else cannot be traced to anyone, which
    # Article P4 calls a defect rather than a gap.
    message = @channel.messages.create!(author: @alice, body: "@agent what did we agree?")
    run = agent_run(user: @alice, channel: @channel, trigger: message)
    run.update!(model: "ChatGPT 5.5")

    rpc("tools/call", { name: "execute_capability", arguments: {
      uri: "workroom://memory/remember",
      args: { title: "Monthly rollups", detail: "First Tuesday, agreed with Acme." } } })

    entry = MemoryEntry.current.find_by(title: "Monthly rollups")
    assert_equal @alice, entry.author, "the person whose agent wrote it"
    assert_equal run, entry.source, "the turn it came from"
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

  # A write to memory is a thing that happened in the room, so the room's
  # journal says it happened — with the uri rather than a row id, because the
  # rail writes to whichever store is configured and only the uri means the same
  # thing in both.
  test "what an agent remembers lengthens the room's journal" do
    run = agent_run(user: @alice, channel: @channel)

    assert_difference -> { @channel.channel_records.where(kind: "memory").count }, 1 do
      rpc("tools/call", { name: "execute_capability", arguments: {
        uri: "workroom://memory/remember",
        args: { title: "Pricing objection", detail: "Setup cost, not price." } } })
    end

    written = MemoryEntry.current.find_by(title: "Pricing objection")
    entry = journal.last
    assert_nil entry.subject_id, "the uri is the reference, not a row this store happens to have"

    payload = payload_of(entry)
    assert_equal "remember", payload["action"]
    assert_equal written.uri, payload["uri"]
    assert_equal "Pricing objection", payload["title"]
    assert_equal "Setup cost, not price.", payload["detail"],
                 "the journal holds what the agent recorded, not only that it recorded"
    assert_equal "agent", payload["trust"]
    assert_equal @alice.id, payload["author_id"], "whose agent wrote it (Article P4)"
    assert_equal run.id, payload["run_id"], "the turn it came from (Article P4)"
  end

  test "a remember the rail refused is in no journal" do
    assert_no_difference -> { @channel.channel_records.count } do
      rpc("tools/call", { name: "execute_capability", arguments: {
        uri: "workroom://memory/remember", args: { title: "No detail with it" } } })
    end
  end

  # Superseding is the correction mechanism (Article P3), so the record has to
  # be able to tell a correction from a new claim.
  test "a supersession is recorded, and says which way it went" do
    stale = MemoryEntry.last

    assert_difference -> { @channel.channel_records.where(kind: "memory").count }, 1 do
      rpc("tools/call", { name: "execute_capability", arguments: {
        uri: "workroom://memory/supersede",
        args: { uri: stale.uri, reason: "contradicted by a later call" } } })
    end

    payload = payload_of(journal.last)
    assert_equal "supersede", payload["action"]
    assert_equal stale.uri, payload["uri"]
    assert_equal "contradicted by a later call", payload["reason"]
  end

  test "a supersession that was refused is in no journal" do
    other = channel(name: "Marketing")
    theirs = @store.write(other, title: "Campaign brief", detail: "Elsewhere.")

    assert_no_difference -> { ChannelRecord.count } do
      rpc("tools/call", { name: "execute_capability", arguments: {
        uri: "workroom://memory/supersede",
        args: { uri: theirs.uri, reason: "not mine to correct" } } })
    end
  end

  test "an unknown capability answers with an error" do
    out = rpc("tools/call", { name: "execute_capability", arguments: { uri: "viking://nope" } })

    assert out.dig("result", "isError"), "a bad uri is a tool error, not a protocol error"
  end
end
