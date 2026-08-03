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

  # The boundary is a convention, not a control — so it has to say the
  # convention. An agent that was never told memory is written through the
  # rail will write around the journal, and nothing downstream can tell
  # (#213).
  test "the boundary states how memory is written and where its lineage lives" do
    boundary = context_for["boundary"]

    assert_includes boundary, "workroom://memory/remember",
                    "the write path is named, or an agent writes around the journal"
    assert_includes boundary, ".meta.json",
                    "the sidecar convention is documented, or no agent can read an entry's lineage"
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

  # A room whose memory is away is still a room. It opens, and it is told which
  # of the two it is looking at — a store that is down, or a room that has
  # learned nothing. Before this, the first of those was a 500 (#146).
  test "a room whose memory cannot be reached opens and says so" do
    Memory::Store.current = Memory::OpenViking.new(base_url: "http://does-not-resolve.invalid",
                                                   api_key: "unused")

    body = context_for

    assert_response :success
    assert_equal "unavailable", body["memory"]
    assert_nil body["context"], "nothing to inject, and the fact beside it says why"
  end

  test "a room whose memory answers says so, and carries what it knows" do
    Memory::Store.current = Memory::Local.new
    Memory::Store.current.write(@channel, title: "Reporting cadence", detail: "Monthly.", trust: "human")

    body = context_for

    assert_equal "ok", body["memory"]
    assert_includes body["context"], "Reporting cadence"
  end

  test "a room somebody is not in tells them nothing" do
    private_room = channel(name: "Salaries")
    private_room.update!(visibility: "private")

    get api_v1_channel_context_path(private_room.slug), headers: auth(user(name: "Bob"))

    assert_response :forbidden
  end

  # Opening a room is `show`, and the count it carries is read from the same
  # store. Translating the transport failure without saying so here would turn a
  # 500 into a room reporting that it knows nothing — the number people actually
  # look at, and the failure #99 already cost once.
  def opening(person = @alice)
    get api_v1_channel_path(@channel.slug), headers: auth(person)
    response.parsed_body
  end

  test "a room whose memory cannot be reached opens without claiming to know nothing" do
    Memory::Store.current = Memory::OpenViking.new(base_url: "http://does-not-resolve.invalid",
                                                   api_key: "unused")

    body = opening

    assert_response :success
    assert_equal "unavailable", body["memory"]
    refute body.key?("memory_count"),
           "zero is a number a person cannot tell from the truth; absent is honest"
  end

  test "a room whose memory answers opens with the count and says so" do
    Memory::Store.current = Memory::Local.new
    Memory::Store.current.write(@channel, title: "Reporting cadence", detail: "Monthly.", trust: "human")

    body = opening

    assert_equal "ok", body["memory"]
    assert_equal 1, body["memory_count"]
  end
end
