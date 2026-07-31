require "test_helper"

class AgentRunTest < ActiveSupport::TestCase
  setup do
    @channel = channel
    @alice = user(name: "Alice")
    @run = agent_run(user: @alice, channel: @channel,
                     trigger: @channel.messages.create!(author: @alice, body: "@agent what did we agree?"))
  end

  test "a finished run writes nothing to memory on its own" do
    # The distiller is the agent (#55). A job that copies every answer into
    # memory fills the room with the transcript it already has, titled with the
    # question that produced it — and it does so whether or not the agent
    # decided anything was worth keeping.
    @run.messages.create!(channel: @channel, body: "Monthly rollups, first Tuesday.")

    assert_no_difference -> { MemoryEntry.count } do
      perform_enqueued_jobs { @run.update!(status: "succeeded") }
    end
  end

  test "what an agent chose to keep is still kept" do
    # Through the rail, deliberately, which is the only path there is now.
    entry = Memory::Store.current.write(@channel, title: "Reporting cadence",
                                        detail: "Monthly.", trust: "agent")

    assert_includes Memory::Store.current.all(@channel).map(&:uri), entry.uri
  end
end
