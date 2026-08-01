require "test_helper"

# Mentioning a colleague who is not in the room. Anybody in the channel may add
# them: a room inside a workspace somebody already belongs to is not a boundary
# worth defending, and it is Slack's answer too.
#
# The boundary that *is* worth defending is the workspace, and it holds here.
class Api::V1::AddingToAChannelTest < ActionDispatch::IntegrationTest
  setup do
    @acme = workspace(name: "Acme")
    @alice = user(name: "Alice", email: "alice@acme.test", workspace: @acme)
    @bob = user(name: "Bob", email: "bob@acme.test", workspace: @acme)
    enter(@acme)
    @channel = channel(name: "Meetings")
    @channel.memberships.create!(user: @alice, role: "owner")
    @json = { "Content-Type" => "application/json" }
  end

  def add(handle, as: @alice, to: @channel)
    post api_v1_channel_members_path(to.slug), params: { handle: }.to_json,
                                               headers: auth(as).merge(@json)
    response.parsed_body
  end

  test "a colleague in this workspace joins the room" do
    body = add(@bob.handle)

    assert_response :created
    assert_equal "Bob", body["name"]
    assert @bob.member_of?(@channel)
  end

  test "somebody already in it is not added twice" do
    add(@bob.handle)
    add(@bob.handle)

    assert_response :created
    assert_equal 1, @channel.memberships.where(user: @bob).count
  end

  # The handle exists so there is something to type after an `@`; a name is what
  # a colleague reads and an email is what a provider knows.
  test "a handle comes from the address, and is what a mention resolves against" do
    assert @bob.handle.start_with?("bob"), "#{@bob.handle} does not come from bob@acme.test"
    assert @alice.handle.start_with?("alice")
  end

  test "two people with the same address elsewhere get different handles" do
    other = user(name: "Bob", email: "bob@globex.test", workspace: @acme)

    refute_equal @bob.handle, other.handle, "a mention has to reach one person"
  end

  # This is the boundary that matters, and the endpoint refuses rather than
  # reporting: whether a stranger exists is not this room's to say.
  test "somebody from another workspace cannot be pulled into this room" do
    globex = workspace(name: "Globex")
    stranger = user(name: "Mallory", email: "mallory@globex.test", workspace: globex)
    enter(@acme)

    body = add(stranger.handle)

    assert_response :not_found
    assert_match(/nobody here/, body["error"])
    refute stranger.reload.member_of?(@channel)
  end

  test "somebody outside the channel does not add people to it" do
    private_room = channel(name: "Salaries")
    private_room.update!(visibility: "private")

    add(@bob.handle, as: @bob, to: private_room)

    assert_response :forbidden
  end

  test "the members of a room say what to type at them" do
    add(@bob.handle)

    get api_v1_channel_members_path(@channel.slug), headers: auth(@alice)

    assert_equal [ @alice.handle, @bob.handle ].sort,
                 response.parsed_body.map { |m| m["handle"] }.sort
  end

  test "the workspace says who is in it, which is what a mention is resolved against" do
    get api_v1_workspace_members_path, headers: auth(@alice)

    assert_response :success
    assert_includes response.parsed_body.map { |m| m["handle"] }, @bob.handle
  end
end
