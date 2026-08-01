require "test_helper"

class Api::V1::ArtifactsControllerTest < ActionDispatch::IntegrationTest
  setup do
    @channel = channel
    @alice = user(name: "Alice")
    session = AgentSession.create!(user: @alice, channel: @channel, agent_kind: "opencode")
    @run = session.agent_runs.create!(status: "succeeded")
    @json = { "Content-Type" => "application/json" }
    @transcript = { info: { id: "ses_x", cost: 3, tokens: { input: 100, output: 20 } },
                    messages: [] }.to_json
  end

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
    assert artifact.file.attached?
    assert_equal @transcript, artifact.file.download
  end

  test "a work product that is not text survives the trip" do
    # A chart, a spreadsheet, a rendered document. Sent as text it arrives
    # corrupted, and nothing complains — the file is simply wrong on download.
    png = "\x89PNG\r\n\x1a\n\x00\x00\x00binary".b

    post api_v1_run_artifacts_path(@run),
         params: { name: "chart.png", kind: "file", content_type: "image/png",
                   content_base64: Base64.strict_encode64(png) }.to_json,
         headers: auth(@alice).merge(@json)

    assert_response :created
    assert_equal png, Artifact.last.file.download, "byte for byte"
    assert_equal "image/png", Artifact.last.file.content_type
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
