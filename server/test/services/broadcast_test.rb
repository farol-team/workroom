require "test_helper"

class BroadcastTest < ActiveSupport::TestCase
  setup do
    @channel = channel
    @alice = user(name: "Alice")
    @session = AgentSession.create!(user: @alice, channel: @channel,
                                    agent_kind: "opencode", status: "running")
    @run = @session.agent_runs.create!(status: "running")
  end

  # Capture both audiences at once so routing is asserted, not assumed.
  def route(&block)
    room = []
    owner = []
    room_stream = Broadcast.stream_for(@channel)
    owner_stream = Broadcast.user_stream_for(@alice)
    original = ActionCable.server.method(:broadcast)
    ActionCable.server.define_singleton_method(:broadcast) do |target, payload|
      room  << payload if target == room_stream
      owner << payload if target == owner_stream
      original.call(target, payload)
    end
    block.call
    [ room, owner ]
  ensure
    ActionCable.server.singleton_class.send(:remove_method, :broadcast)
  end

  def step! = Broadcast.step(@run.run_steps.create!(kind: "tool_use", label: "search"))

  test "a step never reaches the room under the default level" do
    assert_equal "outcomes", @session.visibility

    room, owner = route { step! }

    assert_empty room, "another person's tool calls are not what the room shares"
    assert_equal 1, owner.count { |p| p[:type] == "step" }, "the owner always sees their own steps"
  end

  test "a step reaches the room only when its owner chose full" do
    @session.update!(visibility: "full")

    room, owner = route { step! }

    assert_equal 1, room.count { |p| p[:type] == "step" }
    assert_equal 1, owner.count { |p| p[:type] == "step" }
  end

  test "a private session sends the room nothing at all" do
    @session.update!(visibility: "private")

    room, owner = route do
      step!
      Broadcast.message(@channel.messages.create!(author: @run, body: "answer"))
    end

    assert_empty room, "a private session is the owner's; the room learns of it only by presence"
    assert_equal 2, owner.length, "the owner still sees everything they produced"
  end

  test "an agent message reaches the room under outcomes but not under private" do
    shared = @channel.messages.create!(author: @run, body: "answer")

    room, = route { Broadcast.message(shared) }
    assert_equal 1, room.count { |p| p[:type] == "message" }

    @session.update!(visibility: "private")
    room, = route { Broadcast.message(shared) }
    assert_empty room
  end

  test "a person's own message always reaches the room regardless of any level" do
    @session.update!(visibility: "private")

    room, = route { Broadcast.message(@channel.messages.create!(author: @alice, body: "hi")) }

    assert_equal 1, room.count { |p| p[:type] == "message" },
                 "visibility governs an agent session, never what a person says"
  end

  test "run status reaches the room at every level so a colleague knows work is happening" do
    %w[full outcomes private].each do |level|
      @session.update!(visibility: level)
      room, = route { Broadcast.run(@run) }
      assert_equal 1, room.count { |p| p[:type] == "run" },
                   "presence must survive #{level} — otherwise private is indistinguishable from absent"
    end
  end

  test "the presence payload carries no content" do
    @session.update!(visibility: "private")
    room, = route { Broadcast.run(@run) }

    assert_equal %i[type run].sort, room.first.keys.map(&:to_sym).sort
    refute room.first[:run].key?(:body)
  end
end
