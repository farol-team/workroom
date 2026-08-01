require "test_helper"

class Api::V1::MessagesControllerTest < ActionDispatch::IntegrationTest
  setup do
    @channel = channel
    @alice = user(name: "Alice")
  end

  test "a message is stored and announced to the room in the same request" do
    payloads = broadcasts(@channel) do
      post api_v1_channel_messages_path(@channel.slug),
           params: { body: "hello" }.to_json,
           headers: auth(@alice).merge("Content-Type" => "application/json")
    end

    assert_response :created
    assert_equal "hello", @channel.messages.last.body
    assert_equal 1, payloads.count { |p| p[:type] == "message" },
                 "persisting without broadcasting leaves the room blind"
  end

  test "an unauthenticated request is refused" do
    post api_v1_channel_messages_path(@channel.slug),
         params: { body: "hello" }.to_json,
         headers: { "Content-Type" => "application/json" }

    assert_response :unauthorized
    assert_equal 0, @channel.messages.count
  end

  test "a private channel refuses a non-member" do
    private_channel = Channel.create!(slug: "secret-#{SecureRandom.hex(3)}",
                                      name: "Secret", visibility: "private")

    post api_v1_channel_messages_path(private_channel.slug),
         params: { body: "hello" }.to_json,
         headers: auth(@alice).merge("Content-Type" => "application/json")

    assert_response :forbidden
  end
end
