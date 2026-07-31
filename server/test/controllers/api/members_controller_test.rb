require "test_helper"

class Api::MembersControllerTest < ActionDispatch::IntegrationTest
  setup do
    @channel = channel(name: "Meetings")
    @alice = user(name: "Alice")
    @bob = user(name: "Bob")
    @channel.memberships.create!(user: @alice, role: "owner")
    @channel.memberships.create!(user: @bob)
  end

  test "a room says who is in it" do
    get api_channel_members_path(@channel.slug), headers: auth(@alice)

    assert_response :success
    assert_equal %w[Alice Bob], response.parsed_body.map { |m| m["name"] }.sort
    assert_equal "owner", response.parsed_body.find { |m| m["name"] == "Alice" }["role"]
  end

  test "a room says nothing to somebody who is not in it" do
    @channel.update!(visibility: "private")

    get api_channel_members_path(@channel.slug), headers: auth(user(name: "Dana"))

    assert_response :forbidden
  end

  test "an address is not part of who is in the room" do
    # A member list is for recognising colleagues, not for collecting them.
    get api_channel_members_path(@channel.slug), headers: auth(@alice)

    refute_includes response.parsed_body.first.keys, "email"
  end
end
