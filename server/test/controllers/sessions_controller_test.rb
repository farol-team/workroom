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
    token = user.workspace_memberships.sole.api_token
    assert token.present?
    assert_includes response.body, token, "the client is handed the token it will carry"
  end

  test "signing in again is the same person, not a second one" do
    get "/auth/openid_connect/callback"
    first = User.find_by!(email: "dana@farol.run")

    assert_no_difference -> { User.count } do
      get "/auth/openid_connect/callback"
    end
    assert_equal first.id, User.find_by!(email: "dana@farol.run").id
    assert_equal first.workspace_memberships.sole.api_token,
                 first.reload.workspace_memberships.sole.api_token,
                 "a token in use is not rotated on sign-in"
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

  test "a desktop sign-in comes back to the listener that started it" do
    get "/auth/openid_connect", params: { return_port: 51_732, state: "abc123" }
    get "/auth/openid_connect/callback"

    assert_response :redirect
    back = URI.parse(response.location)
    assert_equal [ "http", "127.0.0.1", 51_732 ], [ back.scheme, back.host, back.port ],
                 "the loopback interface, and the port the listener named"
    assert_equal({ "token" => User.find_by!(email: "dana@farol.run").workspace_memberships.sole.api_token,
                   "state" => "abc123" }, Rack::Utils.parse_query(back.query))
  end

  test "a return port is a loopback port or it is nothing" do
    # An unvalidated return address is a way to have this server hand somebody's
    # token to a host of the attacker's choosing.
    [ "80", "0", "70000", "1023", "evil.example.com:443", "', 'x", "-1" ].each do |port|
      get "/auth/openid_connect", params: { return_port: port, state: "abc" }
      get "/auth/openid_connect/callback"

      refute_match(/evil|:80\b/, response.location.to_s, "#{port} must not become a redirect")
      assert_response :success, "#{port} falls back to the page, never to a redirect"
    end
  end

  test "without a listener the browser is told, and told nothing else" do
    get "/auth/openid_connect/callback"

    assert_response :success
    assert_includes response.body, User.find_by!(email: "dana@farol.run").workspace_memberships.sole.api_token
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

class SignInMethodsTest < ActionDispatch::IntegrationTest
  test "a workspace says how it lets people in" do
    # The client cannot guess: a workspace with a provider must not offer a box
    # that takes any address, and one without a provider must offer something.
    get api_v1_auth_methods_path

    assert_response :success
    assert_equal true, response.parsed_body["development"]
    assert_equal false, response.parsed_body["provider"], "no issuer is configured in test"
    assert_equal Workroom::VERSION, response.parsed_body["version"],
                 "a client cannot notice it has drifted from a workspace that will not say what it is"
  end
end

class WhoAmITest < ActionDispatch::IntegrationTest
  test "a client that signed in through the browser can ask whose token it holds" do
    alice = user(name: "Alice")

    get api_v1_me_path, headers: auth(alice)

    assert_response :success
    assert_equal alice.name, response.parsed_body.dig("user", "name")
  end

  test "a token nobody issued gets nothing" do
    get api_v1_me_path, headers: { "Authorization" => "Bearer not-a-token" }

    assert_response :unauthorized
  end
end

class DevelopmentSignInTest < ActionDispatch::IntegrationTest
  test "development sign-in works where it is meant to" do
    post api_v1_auth_path, params: { email: "new@farol.run" }.to_json,
         headers: { "Content-Type" => "application/json" }

    assert_response :success
    assert User.find_by(email: "new@farol.run")
  end

  test "development sign-in is closed in production" do
    # A forgotten development path is an open door: any address, no proof.
    Rails.configuration.x.dev_signin = false
    assert_no_difference -> { User.count } do
      post api_v1_auth_path, params: { email: "intruder@example.com" }.to_json,
           headers: { "Content-Type" => "application/json" }
    end
    assert_response :not_found
  ensure
    Rails.configuration.x.dev_signin = true
  end
end
