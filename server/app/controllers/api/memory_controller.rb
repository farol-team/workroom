module Api
  class MemoryController < BaseController
    def index
      channel!
      authorize_channel!
      return if performed?

      entries = params[:q].present? ?
        Memory::Store.current.search(channel!, params[:q]) :
        channel!.memory_entries.current.by_trust.limit(50)
      render json: entries.map { |e| serialize(e) }
    end

    # Direct write. Distillation proposes a Promotion instead; this path is
    # for a person deliberately recording something the room should know.
    def create
      channel!
      authorize_channel!
      return if performed?

      entry = Memory::Store.current.write(
        channel!, title: params.require(:title), detail: params.require(:detail),
        overview: params[:overview], trust: params[:trust] || "human", author: current_user
      )
      Activity.log(actor: current_user, action: "memory.written", subject: entry)
      render json: serialize(entry), status: :created
    end

    private

    def serialize(e)
      e.slice(:id, :uri, :title, :abstract, :overview, :detail, :trust, :created_at)
    end
  end
end
