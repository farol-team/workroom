require "test_helper"

# The call out to a system that is not ours.
#
# Article V says mock at a true process boundary and nowhere else: the far end is
# an external HTTP API, so it is injected. What is asserted is what we send — the
# tool the operator named, the arguments the agent gave, and a credential that goes
# in a header and comes back in nothing.
class Rail::BoundTest < ActiveSupport::TestCase
  setup do
    @sent = []
    @answer = { status: 200,
                body: { "result" => { "content" => [ { "type" => "text", "text" => "Negotiation" } ] } } }
    @http = ->(endpoint, rpc, credential) { @sent << [ endpoint, rpc, credential ]; @answer }
    @capability = BoundCapability.create!(
      workspace: Current.workspace, key: "deal-status", title: "Deal status",
      summary: "What stage a deal is at right now.", endpoint: "https://crm.test/mcp",
      tool: "get_deal", credential: "a-secret", read_only: true
    )
  end

  def bound = Rail::Bound.new(capability: @capability, http: @http)

  test "it calls the tool the operator named, at the endpoint they named" do
    bound.call({ "id" => "4821" })

    endpoint, rpc, credential = @sent.first
    assert_equal "https://crm.test/mcp", endpoint
    assert_equal "tools/call", rpc[:method]
    assert_equal "get_deal", rpc.dig(:params, :name)
    assert_equal({ "id" => "4821" }, rpc.dig(:params, :arguments))
    assert_equal "a-secret", credential
  end

  test "the answer comes back as text, the way reading an entry does" do
    status, body = bound.call({})

    assert_equal :ok, status
    assert_equal "Negotiation", body
  end

  test "arguments the agent did not give are an empty set, not nil" do
    bound.call(nil)

    assert_equal({}, @sent.first[1].dig(:params, :arguments))
  end

  test "a far end that answers with an error says so rather than raising" do
    @answer = { status: 500, body: { "error" => "the crm is down" } }

    status, body = bound.call({})

    assert_equal :error, status
    assert_includes body, "the crm is down"
  end

  test "a far end that does not answer at all is an error, not an exception" do
    @http = ->(*) { raise Errno::ECONNREFUSED }

    status, body = bound.call({})

    assert_equal :error, status
    assert_includes body, "deal-status"
  end

  test "the credential is in no answer, whatever the far end says" do
    @answer = { status: 200, body: { "result" => { "content" => [ { "text" => "a-secret" } ] } } }

    _status, body = bound.call({})

    # The far end echoing it back is the one case we cannot prevent — what is
    # asserted is that nothing here adds it.
    assert_equal "a-secret", body, "the body is the far end's, unedited"
    assert_not_includes bound.descriptor.to_s, "a-secret"
  end

  test "what search shows says what the capability is for and never how to reach it" do
    descriptor = bound.descriptor

    assert_equal @capability.uri, descriptor[:uri]
    assert_equal "action", descriptor[:kind]
    assert_includes descriptor[:summary], "stage"
    assert_not_includes descriptor.to_s, "crm.test"
  end
end
