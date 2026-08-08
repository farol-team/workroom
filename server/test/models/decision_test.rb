require "test_helper"

# A change to somebody else's system, waiting for a person.
#
# The row is small; what is worth proving is the order of things. A proposal that
# supersedes an earlier one leaves it readable, an answered decision does not answer
# twice, and discussing is a state of the conversation rather than a third ending.
class DecisionTest < ActiveSupport::TestCase
  setup do
    @channel = channel(name: "Sales")
    @alice = user(name: "Alice")
    @run = agent_run(user: @alice, channel: @channel)
    @capability = BoundCapability.create!(
      workspace: Current.workspace, key: "close-deal", title: "Close a deal",
      summary: "Marks a deal won.", endpoint: "https://crm.test/mcp",
      tool: "close_deal", credential: "a-secret", read_only: false
    )
  end

  def propose(args = { "id" => "4821" })
    Decision.propose(capability: @capability, args:, run: @run, channel: @channel)
  end

  test "a proposal starts pending and keeps what was asked for" do
    decision = propose

    assert decision.pending?
    assert_equal({ "id" => "4821" }, decision.arguments)
    assert_equal @capability, decision.bound_capability
    assert_equal @run, decision.agent_run
  end

  test "approving records who and when" do
    decision = propose

    decision.approve!(by: @alice)

    assert_equal "approved", decision.state
    assert_equal @alice, decision.decided_by
    assert decision.decided_at
  end

  test "rejecting keeps the reason, because the agent has to know what to do instead" do
    decision = propose

    decision.reject!(by: @alice, reason: "the customer has not signed")

    assert_equal "rejected", decision.state
    assert_equal "the customer has not signed", decision.reason
  end

  test "discussing leaves it pending and answerable later" do
    decision = propose

    decision.discuss!(by: @alice, reason: "which deal did you mean?")

    assert decision.pending?, "discussing is a state of the conversation, not an ending"
    assert_equal "which deal did you mean?", decision.reason
    assert decision.approve!(by: @alice)
  end

  test "a decision that has been answered is not answered again" do
    decision = propose
    decision.approve!(by: @alice)

    assert_not decision.reject!(by: @alice, reason: "changed my mind")
    assert_equal "approved", decision.reload.state
  end

  test "a corrected proposal supersedes the first, and both stay readable" do
    first = propose({ "id" => "4821" })
    second = propose({ "id" => "4822" })

    assert first.reload.superseded?
    assert_equal first, second.supersedes
    assert_not_nil Decision.find_by(id: first.id), "what was first asked for is part of what happened"
  end

  test "a superseded proposal cannot be answered" do
    first = propose
    propose({ "id" => "4822" })

    assert_not first.reload.approve!(by: @alice)
  end

  test "only what is still pending is waiting on somebody" do
    pending_one = propose
    other = Decision.propose(capability: @capability, args: {}, run: @run,
                             channel: channel(slug: "other", name: "Other"))

    assert_includes @channel.decisions.pending, pending_one
    assert_not_includes @channel.decisions.pending, other
  end
end
