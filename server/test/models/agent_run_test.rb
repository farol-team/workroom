require "test_helper"

class AgentRunTest < ActiveSupport::TestCase
  setup do
    @channel = channel
    @user = user
  end

  test "context occupancy is a fraction of the window the agent reported" do
    run = agent_run(user: @user, channel: @channel)
    run.update!(context_used: 40_000, context_size: 200_000)

    assert_in_delta 0.2, run.context_fraction, 0.001
  end

  test "occupancy is unknown until the agent says otherwise" do
    assert_nil agent_run(user: @user, channel: @channel).context_fraction
  end

  test "a window of zero is unknown, not a division" do
    run = agent_run(user: @user, channel: @channel)
    run.update!(context_used: 10, context_size: 0)

    assert_nil run.context_fraction
  end

  test "a full window reads as full" do
    run = agent_run(user: @user, channel: @channel)
    run.update!(context_used: 200_000, context_size: 200_000)

    assert_in_delta 1.0, run.context_fraction, 0.001
  end

  test "a run knows how long it took, once it has ended" do
    run = agent_run(user: @user, channel: @channel)
    assert_nil run.duration

    run.update!(started_at: 2.minutes.ago, ended_at: Time.current)
    assert_in_delta 120, run.duration, 2
  end

  test "the person stays reachable from the run" do
    run = agent_run(user: @user, channel: @channel)

    assert_equal @user, run.user
    assert_equal @channel, run.channel
  end
end
