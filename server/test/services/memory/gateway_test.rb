require "test_helper"

# What the gateway refuses, and what it lets through untouched.
#
# Article V says mock only at a true process boundary; the store is an external
# HTTP API, so the forwarder is injected and the store is never called. That is
# not a convenience — a refusal that reached the store would not be a refusal, so
# "the forwarder saw nothing" is the assertion that matters most here.
class Memory::GatewayTest < ActiveSupport::TestCase
  SALES = "viking://resources/channels/sales/".freeze
  ORG   = "viking://org/".freeze
  OTHER = "viking://resources/channels/support/".freeze

  setup do
    @forwarded = []
    @forward = ->(rpc, claims) { @forwarded << [ rpc, claims ]; { status: 200, body: { ok: true } } }
    @token = Memory::ScopeToken.mint(account: "acct-1", user_id: 7, prefixes: [ SALES, ORG ])
  end

  def gateway(token: @token) = Memory::Gateway.new(token:, forward: @forward)

  def call(name, arguments = {})
    gateway.call({ "jsonrpc" => "2.0", "id" => 1, "method" => "tools/call",
                   "params" => { "name" => name, "arguments" => arguments } })
  end

  test "a read inside the channel's own region is forwarded" do
    result = call("read", "uri" => "#{SALES}deals/romashka.md")

    assert_equal 200, result[:status]
    assert_equal 1, @forwarded.size
  end

  test "a read of the organization region is forwarded" do
    call("read", "uri" => "#{ORG}skills/how-we-review.md")

    assert_equal 1, @forwarded.size
  end

  test "a read of another channel's region is refused and never reaches the store" do
    result = call("read", "uri" => "#{OTHER}deals/romashka.md")

    assert_empty @forwarded, "the store must not be called for a refused request"
    assert result.dig(:body, :result, :isError), "the agent must see a tool error it can recover from"
  end

  test "a prefix that only looks like ours is refused" do
    call("read", "uri" => "viking://resources/channels/sales-archive/secret.md")

    assert_empty @forwarded
  end

  test "a search targeted outside the region is refused" do
    call("search", "target_uri" => OTHER)

    assert_empty @forwarded
  end

  test "a tool that writes shared memory is refused whatever it names" do
    call("write", "uri" => "#{SALES}deals/romashka.md")
    call("forget", "uri" => "#{SALES}deals/romashka.md")
    call("add_resource", "uri" => "#{SALES}deals/romashka.md")

    assert_empty @forwarded, "the write path into shared memory is ingestion and the rail, not this"
  end

  test "personal tools pass without a uri to check" do
    call("remember", "text" => "the customer prefers email")
    call("recall", "query" => "customer preference")
    call("health")

    assert_equal 3, @forwarded.size
  end

  test "a tool nobody listed is refused rather than guessed at" do
    call("some_new_tool", "uri" => "#{SALES}deals/romashka.md")

    assert_empty @forwarded
  end

  test "handshake and discovery pass through untouched" do
    gateway.call({ "jsonrpc" => "2.0", "id" => 1, "method" => "initialize" })
    gateway.call({ "jsonrpc" => "2.0", "id" => 2, "method" => "tools/list" })

    assert_equal 2, @forwarded.size
  end

  test "an unverifiable token refuses everything before any check" do
    result = Memory::Gateway.new(token: "wrm_nonsense", forward: @forward)
                            .call({ "method" => "tools/list" })

    assert_equal 401, result[:status]
    assert_empty @forwarded
  end

  test "the identity given to the store comes from the token, never from the caller" do
    gateway.call({ "jsonrpc" => "2.0", "id" => 1, "method" => "tools/call",
                   "params" => { "name" => "read",
                                 "arguments" => { "uri" => "#{SALES}a.md", "account" => "acct-2" } } })

    _rpc, claims = @forwarded.first
    assert_equal "acct-1", claims[:account]
    assert_equal 7, claims[:user_id]
  end
end
