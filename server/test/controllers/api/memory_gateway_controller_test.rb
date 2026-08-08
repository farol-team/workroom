require "test_helper"

# The endpoint an agent is given instead of the store's own.
#
# The decisions themselves are proven in `Memory::GatewayTest`; what is proven here
# is that they are actually reached — that the route exists, that the scope token
# authenticates it rather than a membership token, and that a refusal comes back as
# something the agent can read.
class Api::V1::MemoryGatewayControllerTest < ActionDispatch::IntegrationTest
  setup do
    @channel = channel(name: "Sales")
    @alice = user(name: "Alice")
    @json = { "Content-Type" => "application/json" }
    @token = Memory::ScopeToken.mint(account: Current.workspace.id, user_id: @alice.id,
                                     prefixes: [ @channel.memory_uri, "viking://org/" ])
  end

  def rpc(body, token: @token)
    headers = token ? { "Authorization" => "Bearer #{token}" } : {}
    post api_v1_memory_gateway_path, params: body.to_json, headers: headers.merge(@json)
    response.parsed_body
  end

  def read_of(uri)
    rpc({ jsonrpc: "2.0", id: 1, method: "tools/call",
          params: { name: "read", arguments: { uri: uri } } })
  end

  test "a request with no token is refused" do
    rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, token: nil)

    assert_response :unauthorized
  end

  test "a membership token is not a scope token" do
    membership = @alice.workspace_memberships.first!

    rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, token: membership.api_token)

    assert_response :unauthorized
  end

  test "reading another channel's region comes back as an error the agent can read" do
    other = channel(name: "Support")

    body = read_of("#{other.memory_uri}deals/romashka.md")

    assert_response :success
    assert body.dig("result", "isError"), "the agent must be told, not disconnected"
    assert_includes body.dig("result", "content", 0, "text"), "outside this channel's memory"
  end

  test "reading this channel's own region is not refused" do
    # The workspace in this suite has no store configured, so the far end answers
    # 502 rather than content. That is the assertion: a request that got a 502 was
    # forwarded, and a refused one never would have been.
    body = read_of("#{@channel.memory_uri}deals/romashka.md")

    assert_not body.dig("result", "isError"), "an in-scope read must not be refused here"
  end

  test "an expired token is refused however well-formed it is" do
    expired = Memory::ScopeToken.mint(account: Current.workspace.id, user_id: @alice.id,
                                      prefixes: [ @channel.memory_uri ], ttl: -1.second)

    rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, token: expired)

    assert_response :unauthorized
  end
end
