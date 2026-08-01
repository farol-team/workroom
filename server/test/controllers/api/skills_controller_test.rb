require "test_helper"

class Api::V1::SkillsControllerTest < ActionDispatch::IntegrationTest
  setup do
    @channel = channel(name: "Meetings")
    @alice = user(name: "Alice")
    @channel.memberships.create!(user: @alice)
    @json = { "Content-Type" => "application/json" }
  end

  test "a person writes how the work is done here" do
    post api_v1_channel_skills_path(@channel.slug),
         params: { title: "Running a client call",
                   body: "Agenda out the day before. Recap decisions before it ends." }.to_json,
         headers: auth(@alice).merge(@json)

    assert_response :created
    assert_equal "Running a client call", response.parsed_body["title"]
    assert response.parsed_body["uri"].start_with?(@channel.skills_uri),
           "the uri is the permission (Article P5)"
  end

  test "a skill does not become something the room learned" do
    post api_v1_channel_skills_path(@channel.slug),
         params: { title: "Running a client call", body: "Agenda first." }.to_json,
         headers: auth(@alice).merge(@json)

    get api_v1_channel_memory_path(@channel.slug), headers: auth(@alice)

    assert_empty response.parsed_body,
                 "a procedure is not a fact, and mixing them is how a rules file rots"
  end

  test "a channel's skills are its members'" do
    outsider = user(name: "Dana")
    @channel.update!(visibility: "private")

    get api_v1_channel_skills_path(@channel.slug), headers: auth(outsider)
    assert_response :forbidden

    post api_v1_channel_skills_path(@channel.slug),
         params: { title: "Sneaking in", body: "…" }.to_json,
         headers: auth(outsider).merge(@json)
    assert_response :forbidden
  end

  test "writing without a body is refused rather than stored empty" do
    post api_v1_channel_skills_path(@channel.slug),
         params: { title: "Half a skill" }.to_json,
         headers: auth(@alice).merge(@json)

    assert_response :unprocessable_content
  end
end
