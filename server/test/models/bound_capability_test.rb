require "test_helper"

# A capability answered by a system that is not this one. Configuration rather
# than record: a row says what may be reached and with what, and the rail asks it.
class BoundCapabilityTest < ActiveSupport::TestCase
  def build(key: "deal-status", read_only: true, **rest)
    BoundCapability.create!(workspace: Current.workspace, key:, title: "Deal status",
                            summary: "What stage a deal is at right now.",
                            endpoint: "https://crm.test/mcp", tool: "get_deal",
                            credential: "a-secret", read_only:, **rest)
  end

  test "its uri says where it lives without saying which system answers it" do
    assert_equal "workroom://systems/deal-status", build.uri
  end

  test "it is found by the uri an agent was given" do
    made = build

    assert_equal made, BoundCapability.find_by_uri("workroom://systems/deal-status")
  end

  test "a uri for nothing configured finds nothing rather than raising" do
    assert_nil BoundCapability.find_by_uri("workroom://systems/never-configured")
    assert_nil BoundCapability.find_by_uri("viking://resources/channels/sales/a.md")
  end

  test "only what the operator marked read-only is offered" do
    offered = build(key: "deal-status", read_only: true)
    build(key: "close-deal", read_only: false)

    assert_equal [ offered ], BoundCapability.offered.to_a
  end

  test "one key per workspace, because a uri names exactly one thing" do
    build

    assert_raises(ActiveRecord::RecordInvalid) { build }
  end

  test "a capability needs somewhere to send the call and something to call there" do
    assert_raises(ActiveRecord::RecordInvalid) { build(endpoint: nil) }
    assert_raises(ActiveRecord::RecordInvalid) { build(key: "other", tool: nil) }
  end
end
