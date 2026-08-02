require "test_helper"

class Api::V1::ArtifactsControllerTest < ActionDispatch::IntegrationTest
  setup do
    @channel = channel
    @alice = user(name: "Alice")
    session = AgentSession.create!(user: @alice, channel: @channel, agent_kind: "opencode")
    @run = session.agent_runs.create!(status: "succeeded")
    @json = { "Content-Type" => "application/json" }
    # A different session id per run: the test object store is Disk under
    # tmp/storage and nothing empties it between runs, so content that never
    # varies is already stored before the request that is meant to store it —
    # and "the bytes are there" would say nothing.
    @transcript = { info: { id: "ses_#{SecureRandom.hex(4)}", cost: 3,
                            tokens: { input: 100, output: 20 } },
                    messages: [] }.to_json
  end

  def objects = RecordStore::Objects.current

  def journal = @channel.channel_records.order(:seq)

  def envelope_of(entry) = JSON.parse(objects.get(entry.entry_hash))

  test "a transcript is attached to the run it came from" do
    assert_difference -> { Artifact.count }, 1 do
      post api_v1_run_artifacts_path(@run),
           params: { name: "transcript.json", kind: "transcript", content: @transcript }.to_json,
           headers: auth(@alice).merge(@json)
    end

    assert_response :created
    artifact = Artifact.last
    assert_equal @run, artifact.agent_run, "provenance reaches back to the run"
    assert_equal @channel, artifact.channel, "an artifact belongs to the channel (Article D3)"
    assert_equal @transcript, objects.get(artifact.sha256), "the bytes are the record's, addressed by what they are"
  end

  test "a work product that is not text survives the trip" do
    # A chart, a spreadsheet, a rendered document. Sent as text it arrives
    # corrupted, and nothing complains — the file is simply wrong on download.
    png = "\x89PNG\r\n\x1a\n\x00\x00\x00#{SecureRandom.hex(8)}".b

    post api_v1_run_artifacts_path(@run),
         params: { name: "chart.png", kind: "file", content_type: "image/png",
                   content_base64: Base64.strict_encode64(png) }.to_json,
         headers: auth(@alice).merge(@json)

    assert_response :created
    assert_equal png, objects.get(Artifact.last.sha256), "byte for byte"
    assert_equal "image/png", Artifact.last.content_type
  end

  # The address is the content, so the row and the bucket cannot disagree about
  # which bytes these are without somebody having computed the digest twice.
  test "an upload is stored under the digest of what was sent" do
    post api_v1_run_artifacts_path(@run),
         params: { name: "transcript.json", kind: "transcript", content: @transcript }.to_json,
         headers: auth(@alice).merge(@json)

    artifact = Artifact.last
    assert_equal Digest::SHA256.hexdigest(@transcript), artifact.sha256
    assert_equal @transcript.bytesize, artifact.byte_size
    assert_equal "application/json", artifact.content_type, "the default a client sends nothing for"
  end

  # One store, not two. A copy in Active Storage would be bytes the record does
  # not name, kept for as long as nobody notices they are unreferenced.
  test "an upload is not also copied into a second store" do
    assert_no_difference -> { ActiveStorage::Blob.count } do
      post api_v1_run_artifacts_path(@run),
           params: { name: "transcript.json", kind: "transcript", content: @transcript }.to_json,
           headers: auth(@alice).merge(@json)
    end

    assert_not Artifact.last.file.attached?
  end

  # The journal is written by the same request that takes the file, and it says
  # what arrived rather than that something did.
  test "an upload lengthens the room's journal by one entry naming the bytes" do
    assert_difference -> { @channel.channel_records.where(kind: "artifact").count }, 1 do
      post api_v1_run_artifacts_path(@run),
           params: { name: "transcript.json", kind: "transcript", content: @transcript }.to_json,
           headers: auth(@alice).merge(@json)
    end

    assert_equal 1, journal.count, "one thing happened, so one entry"

    artifact = Artifact.last
    entry = journal.last
    assert_equal "artifact", entry.kind
    assert_equal [ "Artifact", artifact.id ], [ entry.subject_type, entry.subject_id ]

    assert_equal({ "name" => "transcript.json", "kind" => "transcript",
                   "sha256" => Digest::SHA256.hexdigest(@transcript),
                   "byte_size" => @transcript.bytesize, "content_type" => "application/json",
                   "run_id" => @run.id },
                 envelope_of(entry)["payload"])
  end

  test "an upload the room refused is in nobody's journal" do
    assert_no_difference -> { @channel.channel_records.count } do
      post api_v1_run_artifacts_path(@run),
           params: { name: "empty.png", kind: "file" }.to_json,
           headers: auth(@alice).merge(@json)
    end

    assert_response :unprocessable_content
  end

  # The client is handed the address, or it has no way to ask for the file back.
  test "the answer carries the address the file can be fetched by" do
    post api_v1_run_artifacts_path(@run),
         params: { name: "transcript.json", kind: "transcript", content: @transcript }.to_json,
         headers: auth(@alice).merge(@json)

    assert_equal Digest::SHA256.hexdigest(@transcript), response.parsed_body["sha256"]
    assert_equal @transcript.bytesize, response.parsed_body["bytes"]
  end

  # Rows written before the record store existed keep their file where it is —
  # this card stores new uploads differently, it does not move old ones. Their
  # size still comes out, and the missing address is said rather than left out,
  # so a client can tell "no download" from "a field this server does not send".
  test "an artifact from before the record store is listed the way it always was" do
    legacy = @channel.artifacts.create!(agent_run: @run, name: "old.json", kind: "transcript")
    legacy.file.attach(io: StringIO.new(@transcript), filename: "old.json",
                       content_type: "application/json")

    get api_v1_channel_artifacts_path(@channel.slug), headers: auth(@alice)

    assert_response :success
    row = response.parsed_body.find { |a| a["name"] == "old.json" }
    assert_equal @transcript.bytesize, row["bytes"]
    assert row.key?("sha256"), "the field is sent for every artifact, empty or not"
    assert_nil row["sha256"]
  end

  test "an attachment must carry something" do
    post api_v1_run_artifacts_path(@run),
         params: { name: "empty.png", kind: "file" }.to_json,
         headers: auth(@alice).merge(@json)

    assert_response :unprocessable_content
    assert_equal 0, Artifact.count, "an artifact with no file is not an artifact"
  end

  test "attaching does not touch the channel's memory" do
    assert_no_difference -> { MemoryEntry.count } do
      post api_v1_run_artifacts_path(@run),
           params: { name: "transcript.json", kind: "transcript", content: @transcript }.to_json,
           headers: auth(@alice).merge(@json)
    end
  end

  test "the channel learns of it" do
    payloads = broadcasts(@channel) do
      post api_v1_run_artifacts_path(@run),
           params: { name: "transcript.json", kind: "transcript", content: @transcript }.to_json,
           headers: auth(@alice).merge(@json)
    end

    assert_equal 1, payloads.count { |p| p[:type] == "artifact" }
  end

  test "the channel's artifacts are listed" do
    post api_v1_run_artifacts_path(@run),
         params: { name: "transcript.json", kind: "transcript", content: @transcript }.to_json,
         headers: auth(@alice).merge(@json)

    get api_v1_channel_artifacts_path(@channel.slug), headers: auth(@alice)

    assert_response :success
    assert_equal [ "transcript.json" ], response.parsed_body.map { |a| a["name"] }
  end

  test "somebody else's run will not take an artifact" do
    post api_v1_run_artifacts_path(@run),
         params: { name: "x.json", content: "{}" }.to_json,
         headers: auth(user(name: "Bob")).merge(@json)

    assert_response :not_found
  end

  test "an unauthenticated request is refused" do
    post api_v1_run_artifacts_path(@run), params: { name: "x.json", content: "{}" }.to_json, headers: @json

    assert_response :unauthorized
  end
end
