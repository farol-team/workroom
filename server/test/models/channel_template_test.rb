require "test_helper"

class ChannelTemplateTest < ActiveSupport::TestCase
  test "a workspace has a shape to start from" do
    assert_operator ChannelTemplate.all.size, :>=, 6
    assert_includes ChannelTemplate.all.map(&:key), "engineering"
  end

  test "a template carries skills and never memory" do
    # Seeding a room with facts would be seeding it with somebody else's facts,
    # and the first thing memory has to be is true for this room.
    ChannelTemplate.all.each do |template|
      refute_respond_to template, :memory, "#{template.key} must not carry memory"
      template.skills.each do |skill|
        assert skill[:title].present?, "#{template.key} has a skill with no title"
        assert skill[:body].present?, "#{template.key} has a skill with no body"
      end
    end
  end

  test "creating from a template makes the channel and its skills, and nothing else" do
    alice = user(name: "Alice")

    channel = ChannelTemplate.find("strategy").create!(owner: alice)

    assert_equal "strategy", channel.slug
    assert_equal "Strategy", channel.name
    assert_equal alice, channel.memberships.find_by(role: "owner").user
    assert_equal [ "Writing an objective" ], Memory::Store.current.skills(channel).map(&:title)
    assert_empty Memory::Store.current.all(channel), "a new room knows nothing yet"
  end

  test "a template honors the visibility the caller asked for" do
    # `# legal` picked with "private" must not open an open room.
    channel = ChannelTemplate.find("legal").create!(owner: user(name: "Alice"), visibility: "private")

    assert_equal "private", channel.visibility
  end

  test "a template asked for nothing makes an open room, as before" do
    channel = ChannelTemplate.find("strategy").create!(owner: user(name: "Alice"))

    assert_equal "open", channel.visibility
  end

  test "a template nobody defined is a refusal, not an empty channel" do
    assert_nil ChannelTemplate.find("astrology")
  end

  test "a template with no skills is still a room" do
    channel = ChannelTemplate.find("finance").create!(owner: user(name: "Alice"))

    assert_equal "Finance", channel.name
    assert_empty Memory::Store.current.skills(channel)
  end
end
