module Api
  module V1
    class ChannelsController < BaseController
      before_action :require_channel_access!, only: %i[show context]

      def index
        rooms = Channel.order(:name).to_a
        # One grouped count for the whole sidebar. A count per room is a fan-out
        # across every room in the workspace, paid on every refresh by every
        # client — and it grew with the workspace, which is the half nobody
        # notices until a workspace is large (#177). A room nobody has spoken in
        # has no key here and is still a room that has said nothing.
        counts = Message.group(:channel_id).count
        render json: rooms.map { |c| serialize(c, counts.fetch(c.id, 0)) }
      end

      # The shape a room can be added with. Offered, never created: a team with no
      # legal department should not be handed an empty `# legal`.
      #
      # A brand new workspace is the one exception, and it opens with three rooms
      # rather than none — an empty workspace is a screen with nothing on it to
      # press. See Workspace::FIRST_ROOMS.
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
          return render json: serialize(channel, channel.messages.count), status: :created
        end

        channel = Channel.create!(
          slug: params.require(:slug), name: params.require(:name),
          purpose: params[:purpose], visibility: params[:visibility] || "open"
        )
        channel.memberships.create!(user: current_user, role: "owner")
        Activity.log(actor: current_user, action: "channel.created", subject: channel)
        render json: serialize(channel, channel.messages.count), status: :created
      end

      # The one setting a room has so far: which repository its work lives in
      # (#203). A setting is not a read, so this checks membership where `show`
      # settles for an open door — a stranger may look at an open room, and may
      # not say what it is about.
      #
      # Blank means none: the value is stripped and an empty answer writes NULL
      # back, so clearing the setting and never having set it stay the same
      # fact. No format validation — the address is for the agent that clones
      # it, and a typo there is a checkout error, not a 422 here.
      def update
        @channel = Channel.find_by!(slug: params[:slug])
        return render_error("not a member of this channel", :forbidden) unless current_user.member_of?(@channel)

        url = params[:repository_url].to_s.strip.presence
        count = @channel.messages.count
        # A patch that changes nothing is still answered, but the journal is
        # append-only and a "changed nothing" entry in it is noise the chain
        # then carries forever — so only a real change is recorded, logged and
        # told to the room.
        if url != @channel.repository_url
          from = @channel.repository_url
          @channel.update!(repository_url: url)
          RecordStore::Append.call(
            channel: @channel, kind: "channel.updated", subject: @channel,
            payload: { field: "repository_url", from:, to: url, author_id: current_user.id }
          )
          Activity.log(actor: current_user, action: "channel.updated", subject: @channel)
          Broadcast.channel(@channel, serialize(@channel, count))
        end

        render json: serialize(@channel, count)
      end

      def show
        channel!.memberships.find_or_create_by!(user: current_user)
        store = Memory::Store.current
        # One store call, for one room somebody just opened. The listing does
        # not carry this: a count per channel there is a fan-out across every
        # room in the sidebar, paid on every refresh (#99).
        count = store.count(channel!)
        # Asked after the count, because that call is what learns it. A store
        # that could not be reached counts nothing, and a nothing rendered as 0
        # is the room claiming to know nothing — the same lie #99 told. So the
        # number is left out rather than made up, and what took its place is
        # said instead (#146).
        away = !store.available?

        # The serializer names whoever's agent wrote an answer, which is the run's
        # session's person — three steps from the message. Walked per row that is
        # a query per agent message in the room; loaded for the whole page it is
        # one statement per table the chain crosses, whatever the room has said
        # (#177). The nesting travels through the polymorphic author and reaches
        # only the side that has it.
        #
        # Loaded after the page is in hand rather than through `includes`: `last`
        # reads the newest rows and hands them back oldest first, so preloading
        # from the array asks for the people in the order the room saw them —
        # which is the order the run chain arrives in too, and the same person
        # asking and answering is then one query rather than two.
        messages = channel!.messages.order(:created_at).last(200)
        ActiveRecord::Associations::Preloader.new(
          records: messages, associations: { author: { agent_session: :user } }
        ).call

        body = serialize(channel!, channel!.messages.count).merge(
          memory: away ? "unavailable" : "ok",
          messages: messages.map { |m| MessageSerializer.call(m) }
        )
        body[:memory_count] = count unless away
        render json: body
      end

      # What the room knows, ready to be injected into an agent session — and how
      # the agent reaches the rest of it for itself (#114).
      def context
        store = Memory::Store.current
        knows = store.context_for(channel!)
        # A room whose memory is away is still a room: it opens, and it is told
        # which of the two it is looking at rather than being handed a 500 or,
        # worse, silence indistinguishable from a room that has learned
        # nothing (#146). Asked after the call, as in `show`, and answered in
        # the same two words.
        away = !store.available?

        render json: {
          channel: channel!.slug,
          memory_uri: channel!.memory_uri,
          context: away ? nil : knows,
          memory: away ? "unavailable" : "ok",
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
      #
      # The message count is handed in rather than asked for: the listing has one
      # for every room at once and a room being opened has its own, and a
      # serializer that fetched it would put the listing's fan-out back (#177).
      # Required rather than defaulted for the same reason — a default is the
      # fan-out waiting for the next caller that forgets.
      def serialize(c, message_count)
        c.slice(:id, :slug, :name, :purpose, :visibility, :memory_uri, :repository_url)
         .merge(message_count: message_count)
      end
    end
  end
end
