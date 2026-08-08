require "test_helper"

# Where a person's turns run, and what pays for them.
#
# Both are that person's, and only that person's. There is no path here by which one
# member of a workspace writes another's — not an admin path, not a bulk path. A
# credential somebody else could set is a credential that is not theirs, and Article
# P2's whole condition is that it is.
class Api::V1::ExecutionControllerTest < ActionDispatch::IntegrationTest
  setup do
    @alice = user(name: "Alice")
    @bob = user(name: "Bob")
    @json = { "Content-Type" => "application/json" }
  end

  test "a fresh account runs its own agent, which is what it always did" do
    get api_v1_execution_path, headers: auth(@alice)

    assert_response :success
    assert_equal "own", response.parsed_body["mode"]
    assert_nil response.parsed_body["credential"]
  end

  test "a person moves their own turns onto the server, with their own key" do
    patch api_v1_execution_path,
          params: { mode: "hosted", provider: "anthropic", secret: "sk-ant-notreal-0009" }.to_json,
          headers: auth(@alice).merge(@json)

    assert_response :success
    assert_equal "hosted", @alice.reload.execution_mode
    assert_equal "sk-ant-notreal-0009",
                 UserCredential.find_by(user: @alice, provider: "anthropic").secret
  end

  test "the key never comes back out" do
    patch api_v1_execution_path,
          params: { mode: "hosted", provider: "anthropic", secret: "sk-ant-notreal-0010" }.to_json,
          headers: auth(@alice).merge(@json)

    get api_v1_execution_path, headers: auth(@alice)

    assert_not_includes response.body, "sk-ant-notreal-0010"
    assert_equal "anthropic", response.parsed_body.dig("credential", "provider"),
                 "that there is one is worth knowing; what it is, is not"
  end

  # Article P2's condition is that the credential is exactly one person's. A mode
  # somebody else can set is the first step to a key somebody else can set.
  test "nobody sets anybody else's" do
    patch api_v1_execution_path,
          params: { mode: "hosted", user_id: @bob.id, provider: "anthropic", secret: "x" }.to_json,
          headers: auth(@alice).merge(@json)

    assert_response :success
    assert_equal "own", @bob.reload.execution_mode, "the id was not a way in"
    assert_equal "hosted", @alice.reload.execution_mode
  end

  test "a mode nobody implements is refused rather than stored" do
    patch api_v1_execution_path, params: { mode: "somebody-elses-server" }.to_json,
          headers: auth(@alice).merge(@json)

    assert_response :bad_request
    assert_equal "own", @alice.reload.execution_mode
  end

  # Going back is a thing people do, and the key should not linger afterwards.
  test "going back to your own machine takes the key off the server" do
    patch api_v1_execution_path,
          params: { mode: "hosted", provider: "anthropic", secret: "sk-ant-notreal-0011" }.to_json,
          headers: auth(@alice).merge(@json)

    patch api_v1_execution_path, params: { mode: "own" }.to_json,
          headers: auth(@alice).merge(@json)

    assert_equal "own", @alice.reload.execution_mode
    assert_empty UserCredential.where(user: @alice),
                 "a key the server no longer needs is a key it should no longer hold"
  end
end
