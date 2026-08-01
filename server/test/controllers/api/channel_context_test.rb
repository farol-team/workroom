require "test_helper"

# What a session is opened with. Two things travel here that the room's own
# knowledge does not: how to reach the context store, and the sentence asking
# the agent to stay inside its channel — which the store cannot enforce (#115).
class Api::V1::ChannelContextTest < ActionDispatch::IntegrationTest
  setup do
    @channel = channel(name: "Meetings")
    @alice = user(name: "Alice")
  end

  teardown { Memory::Store.current = nil }

  def context_for(person = @alice)
    get api_v1_channel_context_path(@channel.slug), headers: auth(person)
    response.parsed_body
  end

  # The trap #114 recorded: `context_for` returns nil for a room that has learned
  # nothing, so a boundary carried inside it would be absent exactly where an
  # agent has least to go on.
  test "the boundary is stated even when the room knows nothing" do
    body = context_for

    assert_nil body["context"], "this room has learned nothing, which is the case that matters"
    assert_includes body["boundary"], @channel.memory_uri
    assert_match(/only inside it/i, body["boundary"])
  end

  test "the boundary names this channel's root and not a description of one" do
    assert_includes context_for["boundary"], @channel.memory_uri
  end

  test "a workspace with no account of its own reaches no store" do
    assert_nil context_for["store"],
               "no store is right; somebody else's store is the thing to avoid"
  end

  test "a workspace with an account is told where it is and how to reach it" do
    Current.workspace.update!(openviking_url: "https://context.example",
                              openviking_api_key: "a-key")
    # What the room knows is read from the store, and this one does not exist.
    # The field under test is the handle, not what is behind it.
    Memory::Store.current = Memory::Local.new

    store = context_for["store"]

    assert_equal "https://context.example/mcp", store["url"],
                 "the store's surface for agents is mounted at /mcp"
    assert_equal "a-key", store["key"]
  end

  test "a room somebody is not in tells them nothing" do
    private_room = channel(name: "Salaries")
    private_room.update!(visibility: "private")

    get api_v1_channel_context_path(private_room.slug), headers: auth(user(name: "Bob"))

    assert_response :forbidden
  end
end
