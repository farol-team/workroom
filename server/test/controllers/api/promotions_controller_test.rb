require "test_helper"

class Api::PromotionsControllerTest < ActionDispatch::IntegrationTest
  setup do
    @channel = channel
    @alice = user(name: "Alice")
    session = AgentSession.create!(user: @alice, channel: @channel, agent_kind: "opencode")
    @run = session.agent_runs.create!(status: "succeeded")
    @channel.messages.create!(author: @run, body: "Monthly rollups, first Tuesday.")
    @promotion = Promotion.create!(source: @run, channel: @channel, state: "proposed",
                                   rationale: "Worth remembering.")
    @json = { "Content-Type" => "application/json" }
  end

  test "pending proposals are listed for review" do
    get api_channel_promotions_path(@channel.slug), headers: auth(@alice)

    assert_response :success
    assert_equal [ @promotion.id ], response.parsed_body.map { |p| p["id"] }
    assert_equal "Worth remembering.", response.parsed_body.first["rationale"]
  end

  test "approval is what writes to memory, and nothing else is" do
    assert_difference -> { MemoryEntry.count }, 1 do
      perform_enqueued_jobs do
        post api_approve_promotion_path(@promotion), headers: auth(@alice).merge(@json)
      end
    end

    assert_response :success
    assert_equal "applied", @promotion.reload.state
    assert_equal @alice, @promotion.approved_by
  end

  test "rejection writes nothing" do
    assert_no_difference -> { MemoryEntry.count } do
      perform_enqueued_jobs do
        post api_reject_promotion_path(@promotion), headers: auth(@alice).merge(@json)
      end
    end

    assert_equal "rejected", @promotion.reload.state
  end

  test "an unauthenticated request cannot approve" do
    post api_approve_promotion_path(@promotion), headers: @json

    assert_response :unauthorized
    assert_equal "proposed", @promotion.reload.state
  end

  test "a non-member of a private channel cannot approve" do
    @channel.update!(visibility: "private")
    bob = user(name: "Bob")

    post api_approve_promotion_path(@promotion), headers: auth(bob).merge(@json)

    assert_response :forbidden
    assert_equal "proposed", @promotion.reload.state
  end
end
