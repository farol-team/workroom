require "test_helper"

# The websocket handshake is the one boundary this suite doubles: the test case
# drives the real `ApplicationCable::Connection` and only stands in for the
# transport that would carry the token. Everything the connection decides — who
# this is, and which workspace they are in — is measured against real rows.
#
# Two workspaces, because with one of each "the workspace this token belongs to"
# and "a workspace" are the same value, and a socket that reads the wrong room
# for as long as it stays open would pass.
class ApplicationCable::ConnectionTest < ActionCable::Connection::TestCase
  setup do
    @here = Current.workspace
    @elsewhere = workspace(name: "Globex")

    @alice = user(name: "Alice")
    @bruno = user(name: "Bruno", workspace: @elsewhere)
    @alices = @alice.workspace_memberships.sole
    @brunos = @bruno.workspace_memberships.sole
  end

  test "a membership token names the person holding it" do
    connect params: { token: @alices.api_token }

    assert_equal @alice, connection.current_user
    assert_equal @here, connection.current_workspace
  end

  # A connection outlives every request, so the workspace is settled once, at
  # the handshake, and never asked again. Bruno's token is the second workspace
  # in the fixture precisely so that "his room" cannot be satisfied by whichever
  # room happens to be first.
  test "a token settles the workspace it was issued in, not merely a workspace" do
    connect params: { token: @brunos.api_token }

    assert_equal @bruno, connection.current_user
    assert_equal @elsewhere, connection.current_workspace
  end

  test "a token in the Authorization header connects the same way" do
    connect headers: { "Authorization" => "Bearer #{@brunos.api_token}" }

    assert_equal @bruno, connection.current_user
    assert_equal @elsewhere, connection.current_workspace
  end

  test "no token establishes nothing" do
    assert_reject_connection { connect }
  end

  test "a token nobody was issued establishes nothing" do
    assert_reject_connection { connect params: { token: "not-a-token" } }
  end

  test "an empty token establishes nothing" do
    assert_reject_connection { connect params: { token: "" } }
  end
end
