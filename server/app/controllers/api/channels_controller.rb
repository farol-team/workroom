module Api
  class ChannelsController < BaseController
    before_action :require_channel_access!, only: %i[show context]

    def index
      render json: Channel.order(:name).map { |c| serialize(c) }
    end

    # The shape a workspace can start with. Offered, never created — a room
    # nobody asked for is a room nobody opens.
    def templates
      render json: ChannelTemplate.all.map { |t|
        { key: t.key, name: t.name, purpose: t.purpose, skills: t.skills.map { |s| s[:title] },
          taken: Channel.exists?(slug: t.key) }
      }
    end

    def create
      if params[:template].present?
        template = ChannelTemplate.find(params[:template])
        return render_error("no template called #{params[:template]}", :not_found) unless template

        channel = template.create!(owner: current_user)
        Activity.log(actor: current_user, action: "channel.created", subject: channel)
        return render json: serialize(channel), status: :created
      end

      channel = Channel.create!(
        slug: params.require(:slug), name: params.require(:name),
        purpose: params[:purpose], visibility: params[:visibility] || "open"
      )
      channel.memberships.create!(user: current_user, role: "owner")
      Activity.log(actor: current_user, action: "channel.created", subject: channel)
      render json: serialize(channel), status: :created
    end

    def show
      channel!.memberships.find_or_create_by!(user: current_user)
      render json: serialize(channel!).merge(
        # One store call, for one room somebody just opened. The listing does
        # not carry this: a count per channel there is a fan-out across every
        # room in the sidebar, paid on every refresh (#99).
        memory_count: Memory::Store.current.count(channel!),
        messages: channel!.messages.includes(:author).order(:created_at).last(200).map { |m| MessageSerializer.call(m) }
      )
    end

    # What the room knows, ready to be injected into an agent session — and how
    # the agent reaches the rest of it for itself (#114).
    def context
      render json: {
        channel: channel!.slug,
        memory_uri: channel!.memory_uri,
        context: Memory::Store.current.context_for(channel!),
        # Stated separately from `context`, which is nil for a room that has
        # learned nothing — and a new channel is exactly where an agent has
        # least to go on and most room to wander (#114).
        boundary: Memory::Boundary.for(channel!),
        store: store_for(current_workspace)
      }
    end

    private

    # Where this room's context lives and the key that reaches it. Null while a
    # workspace has no account of its own, which is every workspace until one is
    # provisioned — and then the agent gets no store, rather than somebody
    # else's.
    def store_for(room)
      return nil if room&.openviking_url.blank? || room.openviking_api_key.blank?

      { url: "#{room.openviking_url.chomp("/")}/mcp", key: room.openviking_api_key }
    end

    # No memory count here. It was read straight off `memory_entries`, which is
    # empty for every channel once a context database is configured — so the
    # number was not stale, it was structurally zero and would have stayed zero
    # (#99). The store can answer it, but only one room at a time, so the answer
    # belongs to `show`.
    def serialize(c)
      c.slice(:id, :slug, :name, :purpose, :visibility, :memory_uri)
       .merge(message_count: c.messages.count)
    end
  end
end
