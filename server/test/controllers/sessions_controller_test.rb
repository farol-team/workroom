require "test_helper"

class SessionsControllerTest < ActionDispatch::IntegrationTest
  setup do
    OmniAuth.config.test_mode = true
    OmniAuth.config.mock_auth[:openid_connect] = OmniAuth::AuthHash.new(
      provider: "openid_connect", uid: "okta|0001",
      info: { email: "dana@farol.run", name: "Dana Ruiz" }
    )
    # Dana is new here, and new people are admitted by invitation (#227). The
    # sign-in mechanics these tests pin — tokens, redirects, subjects — are the
    # same whichever way somebody got in, and must not depend on whether the
    # database around them happens to be empty (CI seeds it; local runs may not).
    Invitation.create!(workspace: in_a_workspace, invited_by: user(name: "Inviter"),
                       email: "dana@farol.run", role: "member")
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

# Signing up is not the same act as signing in (#227). Against a public issuer
# — accounts.google.com — the provider vouches for every account on the
# internet, so who gets in is this application's decision, not the issuer's.
class SignUpAdmissionTest < ActionDispatch::IntegrationTest
  setup do
    OmniAuth.config.test_mode = true
    OmniAuth.config.mock_auth[:openid_connect] = OmniAuth::AuthHash.new(
      provider: "openid_connect", uid: "google|555",
      info: { email: "sasha@newco.example", name: "Sasha Ito" }
    )
  end

  teardown do
    OmniAuth.config.test_mode = false
    OmniAuth.config.mock_auth[:openid_connect] = nil
  end

  test "a stranger the workspace has not invited is refused, not created" do
    user(name: "Alice")

    assert_no_difference -> { User.count } do
      get "/auth/openid_connect/callback"
    end

    assert_response :forbidden
    assert_includes response.body, "does not admit sasha@newco.example",
                    "a refusal is a different sentence from a failure"
  end

  test "an invitation naming the address is the way in, and is spent by it" do
    alice = user(name: "Alice")
    # The address as somebody typed it — the match must not depend on case.
    invitation = Invitation.create!(workspace: in_a_workspace, invited_by: alice,
                                    email: "Sasha@NewCo.example", role: "member")

    assert_difference -> { User.count }, 1 do
      get "/auth/openid_connect/callback"
    end

    assert_response :success
    sasha = User.find_by!(email: "sasha@newco.example")
    membership = sasha.workspace_memberships.sole
    assert_equal "member", membership.role, "the role is the invitation's"
    assert invitation.reload.spent?, "an invitation that admitted somebody is used up"
    assert_equal sasha, invitation.accepted_by
    assert_includes response.body, membership.api_token
  end

  test "an empty workspace takes its first person as its owner" do
    # There is nobody yet to do the inviting, and a workspace nobody can enter
    # stays empty forever. Emptied by hand, because a seeded database (CI) is
    # not empty and this rule is about the fresh-deploy case.
    WorkspaceMembership.delete_all
    get "/auth/openid_connect/callback"

    assert_response :success
    assert_equal "owner",
                 User.find_by!(email: "sasha@newco.example").workspace_memberships.sole.role
  end

  test "an address the provider has not verified is refused, invitation or not" do
    alice = user(name: "Alice")
    Invitation.create!(workspace: in_a_workspace, invited_by: alice,
                       email: "sasha@newco.example", role: "member")
    OmniAuth.config.mock_auth[:openid_connect] = OmniAuth::AuthHash.new(
      provider: "openid_connect", uid: "google|555",
      info: { email: "sasha@newco.example", name: "Sasha Ito" },
      extra: { raw_info: { email_verified: false } }
    )

    assert_no_difference -> { User.count } do
      get "/auth/openid_connect/callback"
    end

    assert_response :forbidden
    assert_includes response.body, "not a verified address"
  end

  test "a member signs in as before, whoever has joined since" do
    sasha = User.create!(email: "sasha@newco.example", name: "Sasha Ito",
                         provider: "openid_connect", uid: "google|555")
    WorkspaceMembership.create!(user: sasha, workspace: in_a_workspace)
    user(name: "Alice")

    assert_no_difference -> { WorkspaceMembership.count } do
      get "/auth/openid_connect/callback"
    end

    assert_response :success
    assert_includes response.body, sasha.workspace_memberships.sole.api_token
  end

  test "an invitation with no address admits nobody at sign-in" do
    # A code-only invitation is redeemed through the accept endpoint by somebody
    # already signed in; at this door there is no code, only an address.
    alice = user(name: "Alice")
    Invitation.create!(workspace: in_a_workspace, invited_by: alice, role: "member")

    assert_no_difference -> { User.count } do
      get "/auth/openid_connect/callback"
    end

    assert_response :forbidden
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
