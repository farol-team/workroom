require "test_helper"

# The websocket handshake is the one boundary this suite doubles: the test case
# drives the real `ApplicationCable::Connection` and only stands in for the
# transport that would carry the query string. Everything the connection
# decides — who this is, and which room they are in — is measured against real
# rows.
class ApplicationCable::ConnectionTest < ActionCable::Connection::TestCase
  setup do
    @alice = user(name: "Alice")
    @membership = @alice.workspace_memberships.find_by!(workspace: Current.workspace)
  end

  test "a membership token names the person holding it" do
    connect params: { token: @membership.api_token }

    assert_equal @alice, connection.current_user
  end

  # A connection outlives every request, so the room is settled at the
  # handshake. Getting it wrong here is not one bad response, it is a socket
  # that reads the wrong room for as long as it stays open.
  test "the same token settles the room the connection belongs to" do
    connect params: { token: @membership.api_token }

    assert_equal Current.workspace, connection.current_workspace
  end

  test "a token in the Authorization header connects the same way" do
    connect headers: { "Authorization" => "Bearer #{@membership.api_token}" }

    assert_equal @alice, connection.current_user
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
