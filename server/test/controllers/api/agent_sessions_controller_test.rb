require "test_helper"

class Api::AgentSessionsControllerTest < ActionDispatch::IntegrationTest
  setup do
    @channel = channel
    @alice = user(name: "Alice")
    @session = AgentSession.create!(user: @alice, channel: @channel, agent_kind: "opencode")
    @json = { "Content-Type" => "application/json" }
  end

  test "the owner may change how much of their session the room sees" do
    patch api_agent_session_path(@session), params: { visibility: "private" }.to_json,
          headers: auth(@alice).merge(@json)

    assert_response :success
    assert_equal "private", @session.reload.visibility
  end

  test "the change is recorded in the audit trail" do
    assert_difference -> { Activity.count }, 1 do
      patch api_agent_session_path(@session), params: { visibility: "full" }.to_json,
            headers: auth(@alice).merge(@json)
    end
    assert_equal "session.visibility_changed", Activity.last.action
  end

  test "nobody else may change it" do
    bob = user(name: "Bob")

    patch api_agent_session_path(@session), params: { visibility: "full" }.to_json,
          headers: auth(bob).merge(@json)

    assert_response :not_found
    assert_equal "outcomes", @session.reload.visibility
  end

  test "an unknown level is refused" do
    patch api_agent_session_path(@session), params: { visibility: "semi" }.to_json,
          headers: auth(@alice).merge(@json)

    assert_response :unprocessable_entity
    assert_equal "outcomes", @session.reload.visibility
  end
end
