require "test_helper"

# The room's stream is the same record the HTTP API serves, so it answers the
# same question the same way: an open channel admits any member of the
# workspace, a private one admits the people in it. A socket that answered it
# differently would be a second model of who can see what — and the one that
# leaks, because nothing about a stream is refused later.
class RoomChannelTest < ActionCable::Channel::TestCase
  setup do
    @private = Channel.create!(slug: "private-#{SecureRandom.hex(3)}", name: "Private",
                               visibility: "private")
    @open = channel
    @member = user(name: "Member")
    @private.memberships.create!(user: @member, role: "owner")
    @outsider = user(name: "Outsider")
  end

  test "a member of a private channel is streamed it" do
    subscribe_as @member, @private

    assert subscription.confirmed?
    assert_has_stream Broadcast.stream_for(@private)
  end

  test "somebody who is not in a private channel is refused its stream" do
    subscribe_as @outsider, @private

    assert subscription.rejected?,
           "a workspace token was enough to attach to a private room's stream"
  end

  test "the refused subscription is streaming nothing" do
    subscribe_as @outsider, @private

    assert_no_streams
  end

  # What the HTTP gate says about an open room: being in the workspace is the
  # whole of it, and joining is not a step you have to have taken first.
  test "an open channel streams to anybody in the workspace" do
    subscribe_as @outsider, @open

    assert subscription.confirmed?
    assert_has_stream Broadcast.stream_for(@open)
  end

  test "a slug that names no room is refused" do
    stub_connection current_user: @member, current_workspace: Current.workspace
    subscribe slug: "no-such-room"

    assert subscription.rejected?
  end

  private

  def subscribe_as(user, channel)
    stub_connection current_user: user, current_workspace: Current.workspace
    subscribe slug: channel.slug
  end
end
