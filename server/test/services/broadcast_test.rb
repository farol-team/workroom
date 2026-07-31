require "test_helper"

class BroadcastTest < ActiveSupport::TestCase
  setup do
    @channel = channel
    @alice = user(name: "Alice")
    @session = AgentSession.create!(user: @alice, channel: @channel,
                                    agent_kind: "opencode", status: "running")
    @run = @session.agent_runs.create!(status: "running")
  end

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

  # Working in a channel is already the decision to share. There is nothing to
  # configure — the record is complete, and the feed carries outcomes.
  test "a step reaches its owner and stays out of the feed" do
    room, owner = route { Broadcast.step(@run.run_steps.create!(kind: "tool_use", label: "search")) }

    assert_empty room, "forty tool calls are not what a colleague came for"
    assert_equal 1, owner.count { |p| p[:type] == "step" }
  end

  test "an answer reaches the room" do
    room, = route { Broadcast.message(@channel.messages.create!(author: @run, body: "answer")) }

    assert_equal 1, room.count { |p| p[:type] == "message" }
  end

  test "a person's message reaches the room" do
    room, = route { Broadcast.message(@channel.messages.create!(author: @alice, body: "hi")) }

    assert_equal 1, room.count { |p| p[:type] == "message" }
  end

  test "run status reaches the room so a colleague can tell work is happening" do
    room, owner = route { Broadcast.run(@run) }

    assert_equal 1, room.count { |p| p[:type] == "run" }
    assert_equal 1, owner.count { |p| p[:type] == "run" }
  end

  # A plan is what the room came for: the agent saying what it intends.
  test "a plan reaches the room, unlike the steps behind it" do
    step = @run.run_steps.create!(kind: "plan", payload: {
      entries: [ { content: "Read the Q3 deck", status: "in_progress" } ] })

    room, owner = route { Broadcast.plan(step) }

    assert_equal 1, room.count { |p| p[:type] == "plan" }
    assert_equal 1, owner.count { |p| p[:type] == "plan" }
    assert_equal "Read the Q3 deck", room.first.dig(:plan, :entries, 0, "content")
  end

  test "the run payload carries no message body" do
    room, = route { Broadcast.run(@run) }

    refute room.first[:run].key?(:body)
  end

  test "there is no visibility to configure" do
    refute AgentSession.column_names.include?("visibility"),
           "a level is a decision the user already made by opening the channel"
    refute AgentSession.new.respond_to?(:shares_process?)
  end
end
