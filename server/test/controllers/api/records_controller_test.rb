require "test_helper"

# The record read back. Bytes are addressed by what they are, but reaching them
# is a question about a room: the hash is not the permission, the artifact row
# inside the channel is. A hash names the same bytes everywhere, so if it were
# the key, holding one would be reading rights in every room that stored it.
class Api::V1::RecordsControllerTest < ActionDispatch::IntegrationTest
  setup do
    @channel = channel
    @alice = user(name: "Alice")
    @json = { "Content-Type" => "application/json" }
    # Fresh per run: the test object store is Disk under tmp/storage and nothing
    # empties it, so fixed content is already there before the request that is
    # supposed to put it there.
    @bytes = "minutes of the call #{SecureRandom.hex(8)}"
  end

  def upload(room: @channel, person: @alice, name: "notes.txt", content: @bytes,
             content_type: "text/plain")
    run = agent_run(user: person, channel: room)
    # Base64 for text as well as for bytes: a png put in a json string does not
    # survive being generated, and the upload path takes either.
    post api_v1_run_artifacts_path(run),
         params: { name:, kind: "file", content_base64: Base64.strict_encode64(content),
                   content_type: }.to_json,
         headers: auth(person).merge(@json)
    Artifact.find(response.parsed_body["id"])
  end

  test "what was uploaded to a room is handed back byte for byte" do
    artifact = upload

    get api_v1_channel_record_path(@channel.slug, artifact.sha256), headers: auth(@alice)

    assert_response :success
    assert_equal @bytes, response.body
    assert_equal "text/plain", response.media_type
    assert_equal "notes.txt", response.headers["Content-Disposition"][/filename="([^"]+)"/, 1],
                 "a file arrives under the name it was given"
    assert_match(/attachment/, response.headers["Content-Disposition"])
  end

  # Work product is not always text. Sent back as a string it arrives corrupted
  # and nothing complains — the file is simply wrong once it is opened.
  test "a work product that is not text survives the way back" do
    png = "\x89PNG\r\n\x1a\n\x00\x00\x00#{SecureRandom.hex(8)}".b
    artifact = upload(name: "chart.png", content: png, content_type: "image/png")

    get api_v1_channel_record_path(@channel.slug, artifact.sha256), headers: auth(@alice)

    assert_response :success
    assert_equal png, response.body.b
    assert_equal "image/png", response.media_type
  end

  # Article P5. The same bytes stored in two rooms have one address, so the
  # lookup has to run inside the room in the url or a hash overheard anywhere
  # becomes a key to everywhere.
  test "a hash belonging to another room is not a record of this one" do
    other = channel(name: "Marketing")
    artifact = upload(room: other)

    get api_v1_channel_record_path(@channel.slug, artifact.sha256), headers: auth(@alice)

    assert_response :not_found

    # The control: without it "not found" is equally well explained by a
    # download that never finds anything.
    get api_v1_channel_record_path(other.slug, artifact.sha256), headers: auth(@alice)
    assert_response :success
  end

  test "a hash that names nothing anywhere is not found" do
    get api_v1_channel_record_path(@channel.slug, SecureRandom.hex(32)), headers: auth(@alice)

    assert_response :not_found
  end

  # The journal's own envelopes live in the same bucket under the same kind of
  # address. Being in the store is not being an artifact of this room, and a
  # reader that answered from the store alone would serve the room's internal
  # record to anybody who could name it.
  test "a hash the store holds but no artifact of this room names is not found" do
    entry = RecordStore::Append.call(channel: @channel, kind: "message.created", subject: nil,
                                     payload: { "body" => "hello #{SecureRandom.hex(4)}" })
    assert_not_nil RecordStore::Objects.current.get(entry.entry_hash),
                   "the premise: these bytes are in the object store"

    get api_v1_channel_record_path(@channel.slug, entry.entry_hash), headers: auth(@alice)

    assert_response :not_found
  end

  test "a private room refuses somebody who is not in it" do
    artifact = upload
    @channel.update!(visibility: "private")

    get api_v1_channel_record_path(@channel.slug, artifact.sha256), headers: auth(user(name: "Bob"))

    assert_response :forbidden
  end

  test "an unauthenticated request is refused" do
    artifact = upload

    get api_v1_channel_record_path(@channel.slug, artifact.sha256)

    assert_response :unauthorized
  end
end
