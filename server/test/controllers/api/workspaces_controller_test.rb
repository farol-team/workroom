require "test_helper"

# #118 built the boundary and left no way through the front door: a room was
# made by a migration or by a console, and onboarding a team was three manual
# steps. This is the door.
class Api::V1::WorkspacesControllerTest < ActionDispatch::IntegrationTest
  setup do
    @alice = user(name: "Alice")
    @json = { "Content-Type" => "application/json" }
  end

  def make(slug:, name: "Acme", as: @alice)
    post api_v1_workspaces_path, params: { slug:, name: }.to_json, headers: auth(as).merge(@json)
    response.parsed_body
  end

  test "somebody signed into one room can make another and owns it" do
    body = make(slug: "acme-#{SecureRandom.hex(3)}")

    assert_response :created
    assert_equal "owner", body["role"]
    assert_equal 2, @alice.reload.workspaces.count
  end

  test "the new room comes with the token that reaches it" do
    body = make(slug: "acme-#{SecureRandom.hex(3)}")

    assert body["token"].present?, "a room nobody can reach is not a room"
    refute_equal auth(@alice)["Authorization"], "Bearer #{body['token']}",
                 "a token names one room, so a second room means a second token"
  end

  # The point of the whole epic, checked from the outside: a new room is empty
  # of everything, including what the room it was made from knows.
  test "the new workspace opens with rooms rather than an empty screen" do
    token = make(slug: "acme-#{SecureRandom.hex(3)}")["token"]

    get api_v1_channels_path, headers: { "Authorization" => "Bearer #{token}" }

    assert_response :success
    assert_equal %w[general meetings random], response.parsed_body.map { |c| c["slug"] }.sort
  end

  test "and none of the old workspace's" do
    channel(slug: "salaries-#{SecureRandom.hex(3)}", name: "Salaries")
    token = make(slug: "acme-#{SecureRandom.hex(3)}")["token"]

    get api_v1_channels_path, headers: { "Authorization" => "Bearer #{token}" }

    refute_includes response.parsed_body.map { |c| c["name"] }, "Salaries",
                    "the boundary, seen from outside: a new room holds nobody else's channels"
  end

  test "the person who made it is in the rooms it opened with" do
    body = make(slug: "acme-#{SecureRandom.hex(3)}")
    room = Workspace.find_by!(slug: body["slug"])

    room.entered do
      assert_equal 3, Channel.count
      Channel.find_each { |c| assert c.memberships.exists?(user: @alice), "#{c.slug} has nobody in it" }
    end
  end

  test "a name somebody has taken is refused, with a sentence" do
    slug = "acme-#{SecureRandom.hex(3)}"
    make(slug:)

    body = make(slug:, as: user(name: "Bob"))

    assert_response :unprocessable_entity
    assert_match(/slug/i, body["error"], "the refusal names what was wrong with it")
  end

  test "listing shows the rooms somebody is in and no others" do
    mine = make(slug: "mine-#{SecureRandom.hex(3)}")
    make(slug: "theirs-#{SecureRandom.hex(3)}", as: user(name: "Bob"))

    get api_v1_workspaces_path, headers: auth(@alice)
    slugs = response.parsed_body.map { |w| w["slug"] }

    assert_includes slugs, mine["slug"]
    assert_equal 2, slugs.size, "the room Alice signed in to, and the one she made"
  end

  test "listing hands over no tokens" do
    make(slug: "acme-#{SecureRandom.hex(3)}")

    get api_v1_workspaces_path, headers: auth(@alice)

    response.parsed_body.each do |room|
      assert_nil room["token"],
                 "a token for another room, handed to a request authenticated for this one, " \
                 "is the escalation the boundary exists to prevent"
    end
  end

  test "a room made without a store of its own says so rather than pretending" do
    skip "a store is configured, so this room gets its own — see the case below" \
      if ENV["OPENVIKING_URL"].present? && ENV["OPENVIKING_ROOT_KEY"].present?

    body = make(slug: "acme-#{SecureRandom.hex(3)}")

    assert_equal false, body["has_own_context_store"],
                 "sharing the configured store is a fact worth carrying, not a default to hide"
  end

  # The other half, and the one that matters for a second customer: a room made
  # while the server can issue accounts gets its own rather than sharing.
  test "a room made where accounts can be issued gets one" do
    skip "set OPENVIKING_URL and OPENVIKING_ROOT_KEY to run this against a live store" \
      if ENV["OPENVIKING_URL"].blank? || ENV["OPENVIKING_ROOT_KEY"].blank?

    body = make(slug: "acme-#{SecureRandom.hex(3)}")

    assert_equal true, body["has_own_context_store"]
    assert Workspace.find_by(slug: body["slug"]).openviking_api_key.present?,
           "an account it cannot reach is not an account"
  end

  test "nobody signed in makes nothing" do
    post api_v1_workspaces_path, params: { slug: "x", name: "X" }.to_json, headers: @json

    assert_response :unauthorized
  end
end
