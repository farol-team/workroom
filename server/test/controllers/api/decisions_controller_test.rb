require "test_helper"

# The card a person answers.
#
# The far end is an external HTTP API and is the only thing stubbed (Article V);
# everything else here is the real controller, the real model and the real database
# policy.
class Api::V1::DecisionsControllerTest < ActionDispatch::IntegrationTest
  setup do
    @channel = channel(name: "Sales")
    @alice = user(name: "Alice")
    @bob = user(name: "Bob")
    @channel.memberships.create!(user: @alice)
    @channel.memberships.create!(user: @bob)
    @json = { "Content-Type" => "application/json" }
    @capability = BoundCapability.create!(
      workspace: Current.workspace, key: "send-quote", title: "Send the quote",
      summary: "Email the customer the quote we agreed.",
      endpoint: "https://crm.test/mcp", tool: "send_quote",
      credential: "a-secret", read_only: false
    )
  end

  teardown { Rail::Bound.http = nil }

  test "the room sees what is waiting, in the words of the work" do
    propose

    get api_v1_channel_decisions_path(@channel.slug), headers: auth(@alice)

    assert_response :success
    card = response.parsed_body.first
    assert_equal "Send the quote", card["title"]
    assert_equal "Email the customer the quote we agreed.", card["what"]
    assert_equal({ "deal" => "4821" }, card["arguments"])
    assert_equal "pending", card["state"]
  end

  test "the card never carries the credential or where the call goes" do
    propose

    get api_v1_channel_decisions_path(@channel.slug), headers: auth(@alice)

    body = response.body
    assert_not_includes body, "a-secret"
    assert_not_includes body, "crm.test"
  end

  test "yes is the moment the far end is reached, and not before" do
    decision = propose
    called = []
    Rail::Bound.http = lambda do |endpoint, rpc, credential|
      called << [ endpoint, rpc.dig(:params, :arguments), credential ]
      { status: 200, body: { "result" => { "content" => [ { "text" => "Sent" } ] } } }
    end

    post api_v1_channel_decision_path(@channel.slug, decision),
         params: { answer: "approve" }.to_json, headers: auth(@alice).merge(@json)

    assert_response :success
    assert_equal 1, called.size, "the call happens once, when somebody says yes"
    assert_equal [ "https://crm.test/mcp", { "deal" => "4821" }, "a-secret" ], called.first
    assert_equal "approved", decision.reload.state
    assert_equal @alice, decision.decided_by
    assert_equal "Sent", decision.result
  end

  test "no leaves the far end alone and says why" do
    decision = propose
    Rail::Bound.http = ->(*) { raise "nobody said yes" }

    post api_v1_channel_decision_path(@channel.slug, decision),
         params: { answer: "reject", reason: "the price is not agreed yet" }.to_json,
         headers: auth(@bob).merge(@json)

    assert_response :success
    assert_equal "rejected", decision.reload.state
    assert_equal "the price is not agreed yet", decision.reason
  end

  # The third answer is the one that makes the other two honest: without it, "almost,
  # but not like that" has to be said as a no, and the agent hears a refusal where a
  # correction was meant.
  test "discussing leaves the proposal standing" do
    decision = propose
    Rail::Bound.http = ->(*) { raise "discussion is not consent" }

    post api_v1_channel_decision_path(@channel.slug, decision),
         params: { answer: "discuss", reason: "which quote — the revised one?" }.to_json,
         headers: auth(@alice).merge(@json)

    assert_response :success
    assert decision.reload.pending?, "a question is not an answer"
    assert_equal "which quote — the revised one?", decision.reason
  end

  # Two people at their desks press at the same time. The loser has not made a
  # mistake, but the far end must still be called once.
  test "a decision already answered cannot be answered again" do
    decision = propose
    calls = 0
    Rail::Bound.http = ->(*) { calls += 1; { status: 200, body: {} } }

    post api_v1_channel_decision_path(@channel.slug, decision),
         params: { answer: "approve" }.to_json, headers: auth(@alice).merge(@json)
    post api_v1_channel_decision_path(@channel.slug, decision),
         params: { answer: "reject" }.to_json, headers: auth(@bob).merge(@json)

    assert_response :conflict
    assert_equal 1, calls
    assert_equal "approved", decision.reload.state
  end

  # Seeing and answering are not the same right. An open room is readable by the
  # workspace — that is what open means — but saying yes to something that cannot be
  # taken back is the room's own call, and passing through it is not joining it.
  test "an open room can be read by anyone and answered only by its members" do
    decision = propose
    carol = user(name: "Carol")
    Rail::Bound.http = ->(*) { raise "she is not in this room" }

    get api_v1_channel_decisions_path(@channel.slug), headers: auth(carol)
    assert_response :success

    post api_v1_channel_decision_path(@channel.slug, decision),
         params: { answer: "approve" }.to_json, headers: auth(carol).merge(@json)
    assert_response :forbidden
    assert decision.reload.pending?
  end

  test "a private room is not readable from outside it either" do
    @channel.update!(visibility: "private")
    propose

    get api_v1_channel_decisions_path(@channel.slug), headers: auth(user(name: "Carol"))

    assert_response :forbidden
  end

  test "a far end that fails is an answer about that system, not a lost decision" do
    decision = propose
    Rail::Bound.http = ->(*) { { status: 502, body: { "error" => "the CRM is down" } } }

    post api_v1_channel_decision_path(@channel.slug, decision),
         params: { answer: "approve" }.to_json, headers: auth(@alice).merge(@json)

    assert_response :success
    assert_equal "approved", decision.reload.state, "the person did say yes"
    assert_includes decision.result, "the CRM is down"
  end

  private

  def propose
    Decision.propose(capability: @capability, args: { deal: "4821" },
                     run: nil, channel: @channel)
  end
end
