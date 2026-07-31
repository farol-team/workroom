require "test_helper"

class DistillRunJobTest < ActiveSupport::TestCase
  setup do
    @channel = channel
    @alice = user(name: "Alice")
    session = AgentSession.create!(user: @alice, channel: @channel, agent_kind: "opencode")
    @run = session.agent_runs.create!(status: "succeeded", ended_at: Time.current)
    @channel.messages.create!(author: @run, body: "Acme asked for monthly rollups, first Tuesday.")
  end

  # Article P3 as amended: the agent writes. No approval, no queue, no person
  # in the path — their attention belongs on the work.
  test "a finished run writes to the channel's memory" do
    assert_difference -> { MemoryEntry.count }, 1 do
      DistillRunJob.perform_now(@run.id)
    end

    entry = MemoryEntry.last
    assert_equal @channel, entry.channel
    assert_equal "agent", entry.trust, "a distilled conclusion is an inference"
    assert_equal @run, entry.source, "provenance is mandatory (Article P4)"
    assert entry.uri.start_with?(@channel.memory_uri)
  end

  test "nothing is proposed, because there is nothing to approve" do
    DistillRunJob.perform_now(@run.id)

    refute defined?(Promotion), "the gate is gone"
  end

  test "a run that produced nothing writes nothing" do
    session = AgentSession.create!(user: @alice, channel: @channel, agent_kind: "opencode")
    empty = session.agent_runs.create!(status: "succeeded", ended_at: Time.current)

    assert_no_difference -> { MemoryEntry.count } do
      DistillRunJob.perform_now(empty.id)
    end
  end

  test "a failed run writes nothing" do
    @run.update!(status: "failed")

    assert_no_difference -> { MemoryEntry.count } do
      DistillRunJob.perform_now(@run.id)
    end
  end

  test "distilling the same run twice writes once" do
    DistillRunJob.perform_now(@run.id)

    assert_no_difference -> { MemoryEntry.count } do
      DistillRunJob.perform_now(@run.id)
    end
  end
end
