require "test_helper"

# A token that names a workspace makes authenticating and scoping one act. The
# alternative — authenticate, then remember to scope — is the shape every
# multi-tenant leak has, and the point of #134 is that there is no second step
# for anybody to forget.
class Api::V1::WorkspaceAuthenticationTest < ActionDispatch::IntegrationTest
  setup do
    @workspace = Workspace.create!(slug: "acme-#{SecureRandom.hex(3)}", name: "Acme")
    @alice = user(name: "Alice", workspace: @workspace)
    @membership = @alice.workspace_memberships.sole
  end

  def me(token)
    get api_v1_me_path, headers: { "Authorization" => "Bearer #{token}" }
  end

  test "a membership token is the person and the room at once" do
    me(@membership.api_token)

    assert_response :success
    assert_equal @alice.name, response.parsed_body.dig("user", "name")
  end

  test "a token nobody holds is nobody" do
    me("not-a-token")

    assert_response :unauthorized
  end

  test "no token at all is not a person with no token" do
    get api_v1_me_path

    assert_response :unauthorized
  end

  # The tokens issued before workspaces existed were copied onto memberships by
  # #134's backfill, so the same string still works — through the membership.
  # What is gone is the other place it could have come from.
  test "a person has no token of their own any more" do
    refute_respond_to User.new, :api_token,
           "two places to hold a token is one place that does not name a room"
  end

  test "a membership issues its own token rather than borrowing one" do
    other = WorkspaceMembership.create!(user: user(name: "Bob"), workspace: @workspace)

    assert other.api_token.present?, "a membership without a token cannot reach its room"
    refute_equal @membership.api_token, other.api_token
  end

  test "one person is in a room once" do
    assert_raises ActiveRecord::RecordInvalid do
      WorkspaceMembership.create!(user: @alice, workspace: @workspace)
    end
  end

  test "a person can be in more than one room, which is why identity is global" do
    second = Workspace.create!(slug: "globex-#{SecureRandom.hex(3)}", name: "Globex")
    there = WorkspaceMembership.create!(user: @alice, workspace: second)

    assert_equal 2, @alice.reload.workspaces.count
    refute_equal @membership.api_token, there.api_token,
                 "one token per room, or a token could not name which one"
  end
end
