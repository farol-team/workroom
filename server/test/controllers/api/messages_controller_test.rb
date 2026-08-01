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
    payloads = broadcasts(@channel) do
      post api_v1_channel_messages_path(@channel.slug),
           params: { body: "hello" }.to_json,
           headers: auth(@alice).merge("Content-Type" => "application/json")
    end

    assert_response :created
    assert_equal 1, @channel.channel_records.count

    message = @channel.messages.last
    entry = @channel.channel_records.order(:seq).last

    assert_equal 1, entry.seq
    assert_equal "message.created", entry.kind
    assert_equal [ "Message", message.id ], [ entry.subject_type, entry.subject_id ]

    # Against what the room was actually handed, not against a second call to
    # the serializer: the two could drift apart and this comparison is the only
    # place that would notice.
    envelope = JSON.parse(RecordStore::Objects.current.get(entry.entry_hash))
    assert_equal payloads.last[:message].as_json, envelope["payload"]
  end

  # The other direction, and the reason the two writes share a transaction. A
  # message the journal could not record must not exist: half a record is a
  # room whose history has a hole in it that nothing marks.
  test "a message the journal cannot record is neither stored nor announced" do
    payloads = broadcasts(@channel) do
      with_a_broken_object_store do
        post api_v1_channel_messages_path(@channel.slug),
             params: { body: "unrecordable" }.to_json,
             headers: auth(@alice).merge("Content-Type" => "application/json")
      rescue IOError
        # How the request ends is another card's subject. What it left behind
        # is this one's.
      end
    end

    assert_equal 0, @channel.messages.count, "the message outlived the entry that should record it"
    assert_equal 0, @channel.channel_records.count
    assert_empty payloads.select { |p| p[:type] == "message" },
                 "the room was told about a message that does not exist"
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

  private
    # A store that cannot take the bytes, staged the same way the suite stages
    # a broadcast: the real object out of the way for one call rather than a
    # mock in its place. The bucket being unreachable is one of the "any
    # reason" a write fails, and the cheapest one to arrange honestly.
    def with_a_broken_object_store
      objects = RecordStore::Objects.current
      objects.define_singleton_method(:put) { |_content| raise IOError, "the bucket is not there" }
      yield
    ensure
      objects.singleton_class.send(:remove_method, :put)
    end
end
