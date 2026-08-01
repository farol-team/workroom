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

  # The journal is written by the same request that writes the message, and it
  # says what the room was told — not a summary of it. A record that drifts from
  # what people saw is worse than none, because it will be believed.
  test "posting a message writes one journal entry saying what the room was told" do
    post api_v1_channel_messages_path(@channel.slug),
         params: { body: "hello" }.to_json,
         headers: auth(@alice).merge("Content-Type" => "application/json")

    assert_response :created
    assert_equal 1, @channel.channel_records.count

    message = @channel.messages.last
    entry = @channel.channel_records.order(:seq).last

    assert_equal 1, entry.seq
    assert_equal "message.created", entry.kind
    assert_equal [ "Message", message.id ], [ entry.subject_type, entry.subject_id ]

    envelope = JSON.parse(RecordStore::Objects.get(entry.entry_hash))
    assert_equal MessageSerializer.call(message).as_json, envelope["payload"]
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
