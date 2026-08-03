require "test_helper"

# The third and last way to hold a token for a workspace. #154 named the other
# two — signing in, and making the room — and said an endpoint that hands one
# over for another room would hand it to an agent too, since an agent holds the
# same token the client does.
#
# This one is safe for the reason those are: it needs a code that travelled out
# of band *and* somebody signed in as themselves.
class Api::V1::InvitationsControllerTest < ActionDispatch::IntegrationTest
  setup do
    @acme = workspace(name: "Acme")
    @owner = user(name: "Alice", workspace: @acme)
    @owner.workspace_memberships.sole.update!(role: "owner")
    enter(@acme)
    @json = { "Content-Type" => "application/json" }
  end

  def invite(as: @owner, **body)
    post api_v1_invitations_path, params: body.to_json, headers: auth(as).merge(@json)
    response.parsed_body
  end

  def accept(code, as:)
    post api_v1_accept_invitation_path(code: code), headers: auth(as).merge(@json)
    response.parsed_body
  end

  test "an owner makes one and it carries the code they have to send" do
    body = invite(email: "bob@example.test")

    assert_response :created
    assert body["code"].present?, "an invitation nobody can quote is not one"
    assert_equal "member", body["role"]
  end

  test "somebody who is only a member does not invite" do
    body = invite(as: user(name: "Mallory", workspace: @acme))

    assert_response :forbidden
    assert_match(/owner or an admin/, body["error"])
  end

  test "redeeming it hands over the token that reaches the room, and nothing else does" do
    code = invite(email: "bob@example.test")["code"]
    bob = user(name: "Bob")

    body = accept(code, as: bob)

    assert_response :success
    assert_equal @acme.slug, body.dig("workspace", "slug")
    assert body["token"].present?
    assert_equal body["token"], bob.workspace_memberships.find_by(workspace: @acme).api_token
  end

  test "it is redeemed once" do
    code = invite(email: "bob@example.test")["code"]
    accept(code, as: user(name: "Bob"))

    body = accept(code, as: user(name: "Carol"))

    assert_response :gone
    assert_match(/already been used/, body["error"],
                 "already used and never existed are different sentences")
  end

  test "a code nobody issued is not an invitation" do
    accept("not-a-code", as: user(name: "Bob"))

    assert_response :not_found
  end

  # What makes this safe rather than a hole: holding a token for one room is not
  # holding a way into another. An agent holds exactly that token.
  test "a token for another room redeems nothing without the code" do
    invite(email: "bob@example.test")
    globex = workspace(name: "Globex")
    stranger = user(name: "Mallory", workspace: globex)

    accept("guessed", as: stranger)

    assert_response :not_found
  end

  test "listing is for the person who has to send them" do
    invite(email: "bob@example.test")

    get api_v1_invitations_path, headers: auth(@owner)

    assert_response :success
    assert_equal 1, response.parsed_body.size
    assert response.parsed_body.first["code"].present?
  end
end
