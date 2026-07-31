require "test_helper"

class MessageTest < ActiveSupport::TestCase
  setup do
    @channel = channel
    @user = user
  end

  test "a reply to a reply is rejected" do
    root = @channel.messages.create!(author: @user, body: "root")
    reply = @channel.messages.create!(author: @user, body: "reply", parent: root)

    nested = @channel.messages.new(author: @user, body: "nested", parent: reply)

    refute nested.valid?
    assert_includes nested.errors[:parent].join, "вложенность"
  end

  test "a reply to a root message is accepted" do
    root = @channel.messages.create!(author: @user, body: "root")
    assert @channel.messages.new(author: @user, body: "reply", parent: root).valid?
  end

  test "an agent message is attributed to the run, not the person" do
    run = agent_run(user: @user, channel: @channel)
    message = @channel.messages.create!(author: run, body: "from the agent")

    assert message.from_agent?
    assert_equal run, message.author
    assert_equal @user, message.author.agent_session.user,
                 "the person must stay reachable from the run"
  end
end
