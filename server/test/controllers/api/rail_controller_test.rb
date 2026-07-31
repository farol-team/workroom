require "test_helper"

# The rail is one MCP endpoint with exactly two tools. Fifty skills as fifty
# tools would charge every session for fifty schemas before anything happened.
class Api::RailControllerTest < ActionDispatch::IntegrationTest
  setup do
    @channel = channel(name: "Meetings")
    @alice = user(name: "Alice")
    @store = Memory::Store.current
    @store.write(@channel, title: "Acme reporting cadence",
                 detail: "Monthly rollups, first Tuesday.", trust: "human", author: @alice)
    @json = { "Content-Type" => "application/json" }
  end

  def rpc(method, params = {}, user: @alice, slug: @channel.slug)
    post api_rail_path(slug),
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
    assert found.first["uri"].start_with?("viking://channels/#{@channel.slug}/")
    refute found.first.key?("detail"), "discovery returns the abstract, not the whole entry"
  end

  test "search offers the actions an agent may take, not only what it may read" do
    found = JSON.parse(rpc("tools/call",
      { name: "search_capabilities", arguments: { query: "remember" } })
      .dig("result", "content", 0, "text"))

    assert_includes found.map { |c| c["uri"] }, "workroom://memory/remember"
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
