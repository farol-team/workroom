require "test_helper"

class SessionsControllerTest < ActionDispatch::IntegrationTest
  setup do
    OmniAuth.config.test_mode = true
    OmniAuth.config.mock_auth[:openid_connect] = OmniAuth::AuthHash.new(
      provider: "openid_connect", uid: "okta|0001",
      info: { email: "dana@farol.run", name: "Dana Ruiz" }
    )
  end

  teardown do
    OmniAuth.config.test_mode = false
    OmniAuth.config.mock_auth[:openid_connect] = nil
  end

  test "a person the provider vouches for gets an account and a token" do
    assert_difference -> { User.count }, 1 do
      get "/auth/openid_connect/callback"
    end

    assert_response :success
    user = User.find_by!(email: "dana@farol.run")
    assert_equal "openid_connect", user.provider
    assert_equal "okta|0001", user.uid, "identity is the provider's subject, not the address"
    assert user.api_token.present?
    assert_includes response.body, user.api_token, "the client is handed the token it will carry"
  end

  test "signing in again is the same person, not a second one" do
    get "/auth/openid_connect/callback"
    first = User.find_by!(email: "dana@farol.run")

    assert_no_difference -> { User.count } do
      get "/auth/openid_connect/callback"
    end
    assert_equal first.id, User.find_by!(email: "dana@farol.run").id
    assert_equal first.api_token, first.reload.api_token, "a token in use is not rotated on sign-in"
  end

  test "the same address from a different provider subject is not the same account" do
    # Otherwise anyone whose provider will issue a token for an address inherits
    # that person's channels.
    get "/auth/openid_connect/callback"

    OmniAuth.config.mock_auth[:openid_connect] = OmniAuth::AuthHash.new(
      provider: "openid_connect", uid: "okta|9999",
      info: { email: "dana@farol.run", name: "Not Dana" }
    )
    assert_no_difference -> { User.count } do
      get "/auth/openid_connect/callback"
    end
    assert_response :unauthorized
  end

  test "a provider that says no signs nobody in" do
    OmniAuth.config.mock_auth[:openid_connect] = :invalid_credentials

    assert_no_difference -> { User.count } do
      get "/auth/openid_connect/callback"
    end
    assert_response :unauthorized
  end

  test "an identity with no address is refused" do
    OmniAuth.config.mock_auth[:openid_connect] = OmniAuth::AuthHash.new(
      provider: "openid_connect", uid: "okta|0002", info: {}
    )

    assert_no_difference -> { User.count } do
      get "/auth/openid_connect/callback"
    end
    assert_response :unauthorized
  end
end

class DevelopmentSignInTest < ActionDispatch::IntegrationTest
  test "development sign-in works where it is meant to" do
    post api_auth_path, params: { email: "new@farol.run" }.to_json,
         headers: { "Content-Type" => "application/json" }

    assert_response :success
    assert User.find_by(email: "new@farol.run")
  end

  test "development sign-in is closed in production" do
    # A forgotten development path is an open door: any address, no proof.
    Rails.configuration.x.dev_signin = false
    assert_no_difference -> { User.count } do
      post api_auth_path, params: { email: "intruder@example.com" }.to_json,
           headers: { "Content-Type" => "application/json" }
    end
    assert_response :not_found
  ensure
    Rails.configuration.x.dev_signin = true
  end
end
