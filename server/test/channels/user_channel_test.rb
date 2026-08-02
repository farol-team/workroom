require "test_helper"

class UserChannelTest < ActionCable::Channel::TestCase
  setup do
    @alice = user(name: "Alice")
    @bob = user(name: "Bob")
  end

  test "the connection's own stream is the one it gets" do
    stub_connection current_user: @alice, current_workspace: Current.workspace
    subscribe

    assert subscription.confirmed?
    assert_has_stream Broadcast.user_stream_for(@alice)
  end

  # The private stream carries steps and everything an agent produced regardless
  # of what its owner showed the room, so whose it is may never come from the
  # subscriber.
  test "nobody else's stream comes with it" do
    stub_connection current_user: @alice, current_workspace: Current.workspace
    subscribe

    assert_has_no_stream Broadcast.user_stream_for(@bob)
  end
end
