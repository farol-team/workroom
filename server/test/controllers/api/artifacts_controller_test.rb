require "test_helper"

class Api::ArtifactsControllerTest < ActionDispatch::IntegrationTest
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
      post api_run_artifacts_path(@run),
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

  test "attaching does not touch the channel's memory" do
    assert_no_difference -> { MemoryEntry.count } do
      post api_run_artifacts_path(@run),
           params: { name: "transcript.json", kind: "transcript", content: @transcript }.to_json,
           headers: auth(@alice).merge(@json)
    end
  end

  test "the channel learns of it" do
    payloads = broadcasts(@channel) do
      post api_run_artifacts_path(@run),
           params: { name: "transcript.json", kind: "transcript", content: @transcript }.to_json,
           headers: auth(@alice).merge(@json)
    end

    assert_equal 1, payloads.count { |p| p[:type] == "artifact" }
  end

  test "the channel's artifacts are listed" do
    post api_run_artifacts_path(@run),
         params: { name: "transcript.json", kind: "transcript", content: @transcript }.to_json,
         headers: auth(@alice).merge(@json)

    get api_channel_artifacts_path(@channel.slug), headers: auth(@alice)

    assert_response :success
    assert_equal [ "transcript.json" ], response.parsed_body.map { |a| a["name"] }
  end

  test "somebody else's run will not take an artifact" do
    post api_run_artifacts_path(@run),
         params: { name: "x.json", content: "{}" }.to_json,
         headers: auth(user(name: "Bob")).merge(@json)

    assert_response :not_found
  end

  test "an unauthenticated request is refused" do
    post api_run_artifacts_path(@run), params: { name: "x.json", content: "{}" }.to_json, headers: @json

    assert_response :unauthorized
  end
end
