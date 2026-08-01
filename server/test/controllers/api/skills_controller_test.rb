require "test_helper"

class Api::V1::SkillsControllerTest < ActionDispatch::IntegrationTest
  setup do
    @channel = channel(name: "Meetings")
    @alice = user(name: "Alice")
    @channel.memberships.create!(user: @alice)
    @json = { "Content-Type" => "application/json" }
  end

  teardown { Memory::Store.current = nil }

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

  # The same door as the memory listing: skills come back as a bare array, and a
  # store that is away produces the array a channel with no conventions does
  # (#146).
  test "skills from a store that cannot be reached say so" do
    Memory::Store.current = Memory::OpenViking.new(base_url: "http://does-not-resolve.invalid",
                                                   api_key: "unused")

    get api_v1_channel_skills_path(@channel.slug), headers: auth(@alice)

    assert_response :success
    assert_empty response.parsed_body
    assert_equal "unavailable", response.headers["X-Memory"],
                 "no skills and no store are different answers"
  end

  test "skills from a store that answers say so too" do
    Memory::Store.current = Memory::Local.new

    get api_v1_channel_skills_path(@channel.slug), headers: auth(@alice)

    assert_equal "ok", response.headers["X-Memory"]
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
