require "test_helper"

class ActivityTest < ActiveSupport::TestCase
  test "a recorded activity cannot be rewritten" do
    activity = Activity.log(actor: user, action: "channel.created")

    assert_raises(ActiveRecord::ReadOnlyRecord) { activity.update!(action: "something.else") }
  end

  test "log records the actor, the action and the metadata" do
    alice = user(name: "Alice")
    activity = Activity.log(actor: alice, action: "memory.written", reason: "test")

    assert_equal alice, activity.actor
    assert_equal "memory.written", activity.action
    assert_equal "test", activity.metadata["reason"]
  end
end
