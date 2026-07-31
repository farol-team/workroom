require "test_helper"

class DistillRunJobTest < ActiveSupport::TestCase
  setup do
    @channel = channel
    @alice = user(name: "Alice")
    session = AgentSession.create!(user: @alice, channel: @channel, agent_kind: "opencode")
    @run = session.agent_runs.create!(status: "succeeded", ended_at: Time.current)
    @channel.messages.create!(author: @run, body: "Acme asked for monthly rollups, first Tuesday.")
  end

  # The article the whole memory design rests on. If this ever passes by
  # accident, an agent can write what the room believes.
  test "a finished run never writes to memory on its own" do
    assert_no_difference -> { MemoryEntry.count } do
      DistillRunJob.perform_now(@run.id)
    end
  end

  test "it proposes, and the proposal is not applied" do
    assert_difference -> { Promotion.count }, 1 do
      DistillRunJob.perform_now(@run.id)
    end

    promotion = Promotion.last
    assert_equal "proposed", promotion.state
    assert_nil promotion.viking_uri, "nothing is written until a person approves"
    assert_equal @channel, promotion.channel
    assert_equal @run, promotion.source
  end

  test "a proposal carries why it was suggested, so review does not mean re-reading the run" do
    DistillRunJob.perform_now(@run.id)
    assert Promotion.last.rationale.present?
  end

  test "a run that produced nothing proposes nothing" do
    session = AgentSession.create!(user: @alice, channel: @channel, agent_kind: "opencode")
    empty = session.agent_runs.create!(status: "succeeded", ended_at: Time.current)

    assert_no_difference -> { Promotion.count } do
      DistillRunJob.perform_now(empty.id)
    end
  end

  test "a failed run proposes nothing" do
    @run.update!(status: "failed")
    assert_no_difference -> { Promotion.count } do
      DistillRunJob.perform_now(@run.id)
    end
  end

  test "distilling the same run twice does not propose twice" do
    DistillRunJob.perform_now(@run.id)
    assert_no_difference -> { Promotion.count } do
      DistillRunJob.perform_now(@run.id)
    end
  end
end
