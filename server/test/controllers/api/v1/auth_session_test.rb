require "test_helper"

# How a page that cannot read its own cookie comes to hold a token.
#
# The cookie is httpOnly, so script cannot take the credential and keep it. The page
# asks for it instead, holds it in a variable, and asks again after a reload — the
# cookie is the durable half, the token in the page is not durable at all.
class Api::V1::AuthSessionTest < ActionDispatch::IntegrationTest
  setup do
    OmniAuth.config.test_mode = true
    OmniAuth.config.mock_auth[:openid_connect] = OmniAuth::AuthHash.new(
      provider: "openid_connect", uid: "okta|0007",
      info: { email: "nell@farol.run", name: "Nell Okafor" }
    )
    Invitation.create!(workspace: in_a_workspace, invited_by: user(name: "Inviter"),
                       email: "nell@farol.run", role: "member")
  end

  teardown do
    OmniAuth.config.test_mode = false
    OmniAuth.config.mock_auth[:openid_connect] = nil
  end

  test "the page asks for the token the cookie carries" do
    sign_in_through_a_browser

    get "/api/v1/auth/session"

    assert_response :success
    assert_equal token, response.parsed_body["token"]
    assert_equal "Nell Okafor", response.parsed_body["name"]
  end

  test "no cookie is no session, and that is not an error the page should shout about" do
    get "/api/v1/auth/session"

    assert_response :unauthorized
  end

  # The cookie is the whole credential, so clearing it has to be the whole sign-out.
  # A page that only forgot its variable would be signed back in by a reload.
  test "signing out makes the next ask refuse" do
    sign_in_through_a_browser

    delete "/api/v1/auth/session"
    assert_response :no_content

    get "/api/v1/auth/session"
    assert_response :unauthorized
  end

  # A cookie is sent by the browser whether or not the page meant to send it. A
  # forged one must be worth no more than a forged bearer token, which is nothing —
  # so this reads it exactly the way the bearer header is read, through the same
  # lookup, and does not trust it for being a cookie.
  test "a cookie nobody issued is not a session" do
    cookies[:workroom_token] = "wrm-not-a-real-token"

    get "/api/v1/auth/session"

    assert_response :unauthorized
  end

  private

  def sign_in_through_a_browser
    get "/auth/openid_connect", params: { return_to: "web" }
    get "/auth/openid_connect/callback"
  end

  def token = User.find_by!(email: "nell@farol.run").workspace_memberships.sole.api_token
end
