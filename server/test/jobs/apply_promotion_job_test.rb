require "test_helper"

class ApplyPromotionJobTest < ActiveSupport::TestCase
  setup do
    @channel = channel
    @alice = user(name: "Alice")
    session = AgentSession.create!(user: @alice, channel: @channel, agent_kind: "opencode")
    @run = session.agent_runs.create!(status: "succeeded")
    @promotion = Promotion.create!(source: @run, channel: @channel, state: "approved",
                                   approved_by: @alice, rationale: "Worth remembering.")
    @channel.messages.create!(author: @run, body: "Monthly rollups, first Tuesday.")
  end

  test "an approved promotion becomes a memory entry marked as an agent's inference" do
    assert_difference -> { MemoryEntry.count }, 1 do
      ApplyPromotionJob.perform_now(@promotion.id)
    end

    entry = MemoryEntry.last
    assert_equal "agent", entry.trust, "a distilled conclusion is an inference, not a statement"
    assert_equal @run, entry.source, "provenance must reach back to the run (Article P4)"
    assert entry.uri.start_with?(@channel.memory_uri)
  end

  test "applying records the resulting uri on the promotion" do
    ApplyPromotionJob.perform_now(@promotion.id)

    @promotion.reload
    assert_equal "applied", @promotion.state
    assert @promotion.viking_uri.present?
  end

  test "a promotion that was never approved is not applied" do
    @promotion.update!(state: "proposed", approved_by: nil)

    assert_no_difference -> { MemoryEntry.count } do
      ApplyPromotionJob.perform_now(@promotion.id)
    end
    assert_equal "proposed", @promotion.reload.state
  end

  test "a rejected promotion is not applied" do
    @promotion.update!(state: "rejected")

    assert_no_difference -> { MemoryEntry.count } do
      ApplyPromotionJob.perform_now(@promotion.id)
    end
  end

  test "applying twice writes once" do
    ApplyPromotionJob.perform_now(@promotion.id)
    assert_no_difference -> { MemoryEntry.count } do
      ApplyPromotionJob.perform_now(@promotion.id)
    end
  end
end
