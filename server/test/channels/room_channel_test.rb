require "test_helper"

# The room's stream is the same record the HTTP API serves, so it answers the
# same two questions the same way. Who may attach: an open channel admits any
# member of the workspace, a private one admits the people in it. And which
# rooms exist at all: the ones inside the workspace the socket belongs to, which
# the database decides rather than a WHERE somebody has to remember.
#
# A subscription is not a request, so nothing has entered a workspace around it
# — `subscribe_as` reproduces that, and every example here runs from the state
# the server is really in when a client attaches.
class RoomChannelTest < ActionCable::Channel::TestCase
  setup do
    @here = Current.workspace
    @elsewhere = workspace(name: "Globex")

    @private = Channel.create!(slug: "private-#{SecureRandom.hex(3)}", name: "Private",
                               visibility: "private")
    @other_private = Channel.create!(slug: "private-#{SecureRandom.hex(3)}", name: "Salaries",
                                     visibility: "private")
    @open = channel
    @member = user(name: "Member")
    @private.memberships.create!(user: @member, role: "owner")
    @outsider = user(name: "Outsider")

    Workspace.entered(@elsewhere) { @theirs = channel(slug: "salaries", name: "Salaries") }
  end

  test "a member of a private channel is streamed it" do
    subscribe_as @member, @private.slug

    assert subscription.confirmed?
    assert_has_stream Broadcast.stream_for(@private)
  end

  test "somebody who is not in a private channel is refused its stream" do
    subscribe_as @outsider, @private.slug

    assert subscription.rejected?,
           "a workspace token was enough to attach to a private room's stream"
    assert_no_streams
  end

  # The one an outsider cannot catch. Somebody with no memberships at all is
  # refused by any check, including one that asks whether this person belongs to
  # a channel and forgets to say which — and that check is the wrong-scoping bug
  # this room is worth having: it hands every private room to anybody who was
  # ever let into one.
  test "belonging to one private channel is not belonging to another" do
    subscribe_as @member, @other_private.slug

    assert subscription.rejected?,
           "a membership in one private room opened a different one"
    assert_no_streams
  end

  # What the HTTP gate says about an open room: being in the workspace is the
  # whole of it, and joining is not a step you have to have taken first.
  test "an open channel streams to anybody in the workspace" do
    subscribe_as @outsider, @open.slug

    assert subscription.confirmed?
    assert_has_stream Broadcast.stream_for(@open)
  end

  test "a slug that names no room is refused" do
    subscribe_as @member, "no-such-room"

    assert subscription.rejected?
  end

  # The cable half of `WorkspaceIsolationTest`. Salaries exists, and the
  # transaction this subscription arrives on is sitting in the workspace that
  # owns it — the only thing between the socket and that room's stream is the
  # channel entering the workspace the *connection* belongs to before it looks
  # anything up.
  test "another workspace's room is not reachable by naming its slug" do
    subscribe_as @member, @theirs.slug, transaction_in: @elsewhere

    assert subscription.rejected?,
           "a slug from another workspace reached its stream"
    assert_no_streams
  end

  # The control for the case above: the row it could not see is really there,
  # and reachable from the workspace that owns it.
  test "the room it cannot see is really there" do
    Workspace.entered(@elsewhere) do
      assert_equal "Salaries", Channel.find_by(slug: @theirs.slug)&.name
    end
  end

  private

  # The socket knows its workspace; the transaction carrying the subscription
  # knows none, exactly as it will in production. A lookup made outside the
  # room therefore finds nothing at all rather than the wrong thing.
  def subscribe_as(person, slug, transaction_in: nil)
    stub_connection current_user: person, current_workspace: @here
    enter(transaction_in)
    subscribe slug: slug
  end
end
