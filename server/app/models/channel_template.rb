# The shape a workspace can start with.
#
# Not a table and not a migration: a team without a legal department should not
# be handed an empty channel called `# legal`, and one with a research group
# should be able to add it by editing a file.
class ChannelTemplate
  FILE = Rails.root.join("config/channel_templates.yml")

  attr_reader :key, :name, :purpose, :skills

  def initialize(key, attrs)
    @key = key
    @name = attrs["name"]
    @purpose = attrs["purpose"]
    @skills = (attrs["skills"] || []).map { |s| { title: s["title"], body: s["body"].to_s.strip } }
  end

  def self.all
    @all ||= YAML.safe_load_file(FILE).map { |key, attrs| new(key, attrs) }
  end

  def self.find(key) = all.find { |t| t.key == key.to_s }

  # Skills, never memory. A room's first fact has to be true for that room, and
  # a template cannot know one.
  #
  # Visibility is the caller's, not the template's: `# legal` picked with
  # "private" must not open an open room (#255).
  def create!(owner:, visibility: nil)
    channel = Channel.create!(slug: key, name: name, purpose: purpose,
                              visibility: visibility.presence || "open")
    channel.memberships.create!(user: owner, role: "owner")

    skills.each do |skill|
      Memory::Store.current.write_skill(channel, title: skill[:title], body: skill[:body], author: owner)
    end
    channel
  end
end
